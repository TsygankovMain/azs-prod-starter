const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

const parsePositiveInt = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return Math.floor(n);
};

export const buildAppReportPath = (reportId) => {
  const id = parsePositiveInt(reportId);
  if (!id) {
    throw new Error('reportId must be a positive integer');
  }
  return `/admin/${id}`;
};

export const buildRestAppUriLink = ({ appCode, reportId }) => {
  const code = String(appCode || '').trim();
  if (!code) {
    return '';
  }

  const path = buildAppReportPath(reportId);
  const params = new URLSearchParams();
  params.set('params[reportId]', String(parsePositiveInt(reportId)));
  params.set('params[path]', path);
  return `/marketplace/view/${encodeURIComponent(code)}/?${params.toString()}`;
};

export const buildPublicReportUrl = ({ baseUrl, reportId }) => {
  const base = trimTrailingSlash(baseUrl);
  if (!base) {
    return '';
  }
  return `${base}${buildAppReportPath(reportId)}`;
};

export const buildReportLinks = ({ appCode, reportId, publicBaseUrl }) => {
  return {
    appPath: buildAppReportPath(reportId),
    restAppUriLink: buildRestAppUriLink({ appCode, reportId }),
    publicReportUrl: buildPublicReportUrl({ baseUrl: publicBaseUrl, reportId })
  };
};

export default buildReportLinks;
