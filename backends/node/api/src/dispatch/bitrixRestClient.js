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

const parseListItems = (result) => {
  const rows = Array.isArray(result) ? result : (Array.isArray(result?.items) ? result.items : []);
  const next = Number(result?.next ?? result?.Next ?? -1);
  return {
    items: rows,
    next: Number.isFinite(next) && next >= 0 ? next : null
  };
};

export const createBitrixRestClient = ({
  endpoint = process.env.BITRIX_REST_ENDPOINT || '',
  authId = process.env.BITRIX_REST_AUTH_ID || '',
  logger = console
} = {}) => {
  const base = normalizeEndpoint(endpoint);
  const isConfigured = Boolean(base);
  const restAuthId = String(authId || '').trim();

  const ensureConfigured = () => {
    if (!isConfigured) {
      throw new Error('BITRIX_REST_ENDPOINT is required in production mode');
    }
  };

  const callInternal = async (method, params = {}, authOverride = '') => {
    ensureConfigured();
    const resolvedAuth = String(authOverride || restAuthId || '').trim();
    const requestPayload = resolvedAuth
      ? { ...params, auth: resolvedAuth }
      : params;

    const url = `${base}/${method}.json`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestPayload)
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Bitrix REST ${method} failed with HTTP ${response.status}${errorBody ? `: ${errorBody}` : ''}`);
    }

    const responsePayload = await response.json();
    if (responsePayload.error) {
      throw new Error(`Bitrix REST ${method} error: ${responsePayload.error} ${responsePayload.error_description || ''}`.trim());
    }

    return responsePayload.result ?? responsePayload;
  };

  const call = async (method, params = {}) => callInternal(method, params, '');
  const callWithAuth = async (method, params = {}, authId = '') => callInternal(method, params, authId);

  return {
    isConfigured,
    callMethod: call,
    callMethodWithAuth: callWithAuth,

    async createReportItem({ entityTypeId, fields }) {
      if (!Number(entityTypeId)) {
        throw new Error('report.entityTypeId is required for crm.item.add');
      }

      const result = await call('crm.item.add', {
        entityTypeId: Number(entityTypeId),
        fields
      });
      const reportItemId = parseReportItemId(result);
      if (!reportItemId) {
        throw new Error('crm.item.add response does not include item id');
      }

      return {
        reportItemId,
        raw: result
      };
    },

    async updateReportItem({ entityTypeId, id, fields }) {
      if (!Number(entityTypeId)) {
        throw new Error('report.entityTypeId is required for crm.item.update');
      }
      if (!Number(id)) {
        throw new Error('report item id is required for crm.item.update');
      }

      const result = await call('crm.item.update', {
        entityTypeId: Number(entityTypeId),
        id: Number(id),
        fields
      });

      return {
        reportItemId: Number(id),
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

    async getCrmItem({ entityTypeId, id }) {
      if (!Number(entityTypeId) || !Number(id)) {
        return null;
      }

      const result = await call('crm.item.get', {
        entityTypeId: Number(entityTypeId),
        id: Number(id)
      });

      return result?.item ?? result ?? null;
    },

    async listCrmItems({
      entityTypeId,
      select = ['id'],
      filter = {},
      order = { id: 'ASC' },
      limit = 200
    }) {
      if (!Number(entityTypeId)) {
        return [];
      }

      const maxItems = Math.min(Math.max(Number(limit) || 200, 1), 2000);
      const items = [];
      let start = 0;

      while (items.length < maxItems) {
        const response = await call('crm.item.list', {
          entityTypeId: Number(entityTypeId),
          select,
          filter,
          order,
          start,
          useOriginalUfNames: 'Y'
        });

        const page = parseListItems(response);
        for (const row of page.items) {
          items.push(row);
          if (items.length >= maxItems) {
            break;
          }
        }

        if (page.next === null || page.items.length === 0) {
          break;
        }
        start = page.next;
      }

      return items;
    },

    diskApi: {
      async findChildFolder(parentId, name) {
        const result = await call('disk.folder.getchildren', {
          id: Number(parentId)
        });

        const items = Array.isArray(result) ? result : (Array.isArray(result.items) ? result.items : []);
        const match = items.find((item) => String(item.NAME || item.name || '').trim() === String(name));
        const matchId = parseId(match?.ID ?? match?.id);
        return matchId ? { id: matchId } : null;
      },

      async createFolder(parentId, name) {
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
