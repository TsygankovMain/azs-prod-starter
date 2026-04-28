const normalizeEndpoint = (value) => String(value || '').replace(/\/+$/, '');

const parseReportItemId = (result) => {
  if (!result) {
    return null;
  }
  if (result.item?.id) {
    return Number(result.item.id);
  }
  if (result.id) {
    return Number(result.id);
  }
  return null;
};

const parseId = (value) => {
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
};

export const createBitrixRestClient = ({
  endpoint = process.env.BITRIX_REST_ENDPOINT || '',
  logger = console
} = {}) => {
  const base = normalizeEndpoint(endpoint);
  const isConfigured = Boolean(base);
  let mockSequence = 5000;
  const mockFolders = new Map();

  const mockKey = (parentId, name) => `${parentId}:${name}`;

  const call = async (method, params = {}) => {
    if (!isConfigured) {
      return {
        mock: true,
        method,
        params
      };
    }

    const url = `${base}/${method}.json`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(params)
    });

    if (!response.ok) {
      throw new Error(`Bitrix REST ${method} failed with HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.error) {
      throw new Error(`Bitrix REST ${method} error: ${payload.error} ${payload.error_description || ''}`.trim());
    }

    return payload.result ?? payload;
  };

  return {
    isConfigured,

    async createReportItem({ entityTypeId, fields }) {
      if (!Number(entityTypeId)) {
        throw new Error('report.entityTypeId is required for crm.item.add');
      }

      const result = await call('crm.item.add', {
        entityTypeId: Number(entityTypeId),
        fields
      });
      const reportItemId = parseReportItemId(result) || (isConfigured ? null : Date.now());
      if (!reportItemId) {
        throw new Error('crm.item.add response does not include item id');
      }

      return {
        reportItemId,
        raw: result
      };
    },

    async notifyUser({ userId, message }) {
      if (!Number(userId)) {
        throw new Error('notifyUser requires userId');
      }

      const result = await call('im.notify.personal.add', {
        USER_ID: Number(userId),
        MESSAGE: String(message || '')
      });

      logger.info('dispatch notify sent', { userId });
      return result;
    },

    diskApi: {
      async findChildFolder(parentId, name) {
        if (!isConfigured) {
          const id = mockFolders.get(mockKey(parentId, name));
          return id ? { id } : null;
        }

        const result = await call('disk.folder.getchildren', {
          id: Number(parentId)
        });

        const items = Array.isArray(result) ? result : (Array.isArray(result.items) ? result.items : []);
        const match = items.find((item) => String(item.NAME || item.name || '').trim() === String(name));
        const matchId = parseId(match?.ID ?? match?.id);
        return matchId ? { id: matchId } : null;
      },

      async createFolder(parentId, name) {
        if (!isConfigured) {
          const key = mockKey(parentId, name);
          if (mockFolders.has(key)) {
            return { id: mockFolders.get(key) };
          }
          mockSequence += 1;
          mockFolders.set(key, mockSequence);
          return { id: mockSequence };
        }

        const result = await call('disk.folder.addsubfolder', {
          id: Number(parentId),
          data: {
            NAME: String(name)
          }
        });
        const folderId = parseId(result?.ID ?? result?.id);
        if (!folderId) {
          throw new Error('disk.folder.addsubfolder response does not include folder id');
        }
        return { id: folderId };
      },

      async uploadFile(folderId, { fileName, content }) {
        if (!isConfigured) {
          mockSequence += 1;
          return { id: mockSequence, fileName };
        }

        const base64 = Buffer.isBuffer(content)
          ? content.toString('base64')
          : Buffer.from(content).toString('base64');

        const result = await call('disk.folder.uploadfile', {
          id: Number(folderId),
          data: {
            NAME: String(fileName)
          },
          fileContent: base64
        });

        const fileId = parseId(result?.ID ?? result?.id);
        if (!fileId) {
          throw new Error('disk.folder.uploadfile response does not include file id');
        }
        return { id: fileId, fileName };
      }
    }
  };
};

export default createBitrixRestClient;
