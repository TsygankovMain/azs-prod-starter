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

export const createBitrixRestClient = ({
  endpoint = process.env.BITRIX_REST_ENDPOINT || '',
  logger = console
} = {}) => {
  const base = normalizeEndpoint(endpoint);
  const isConfigured = Boolean(base);

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
    }
  };
};

export default createBitrixRestClient;

