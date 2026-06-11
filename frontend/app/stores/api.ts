import type { B24Frame } from '@bitrix24/b24jssdk'
import { withoutTrailingSlash } from 'ufo'

type JsonObject = Record<string, unknown>

type ReportRow = {
  id: number
  slotKey: string
  azsId: string
  azsTitle?: string | null
  adminUserId: number
  status: string
  reportItemId: number | null
  jitterMinutes: number | null
  scheduledAt: string | null
  deadlineAt: string | null
  errorText: string | null
  diskFolderId: number | null
  createdAt: string | null
  updatedAt: string | null
}

type ReportsSummary = {
  total: number
  overdue: number
  open: number
  done: number
  expired: number
  failed: number
  byStatus: Record<string, number>
}

type RatingRow = {
  azsId: string; azsTitle?: string | null; total: number
  onTime: number; late: number; avgMinutes: number | null; pct: number
}

type TrendRow = { date: string; total: number; done: number; expired: number; open: number }

type DayPhotoEntry = {
  reportId: number; azsId: string; azsTitle?: string | null; doneAt: string | null
  photos: Array<{ photoCode: string; diskObjectId: number | null; diskFolderId: number | null; exifAt: string | null; uploadedAt: string | null }>
}

type ReasonItem = {
  code: string
  label: string
  count?: number
  share?: number
}

type AppCapabilities = {
  settings: boolean
  reviewer: boolean
  reports: boolean
}

type AppRole = 'admin' | 'reviewer' | 'azs_admin'

type AzsOption = {
  id: string
  title: string
  adminUserId: number
}

export const useApiStore = defineStore(
  'api',
  () => {
    let $b24: null | B24Frame = null
    const config = useRuntimeConfig()
    const apiUrl = withoutTrailingSlash(config.public.apiUrl)

    const tokenJWT = ref('')

    const isInitTokenJWT = computed(() => {
      return tokenJWT.value.length > 2
    })

    // In-flight refresh promise — concurrent 401s collapse into a single
    // /api/getToken call instead of stampeding the backend with N parallel
    // re-issues. Cleared in .finally so a subsequent 401 can re-trigger it.
    let reinitInFlight: Promise<void> | null = null

    /**
     * Single entry-point for token refresh. Deduplicates concurrent callers:
     * if a refresh is already in-flight every caller joins the same promise
     * instead of firing a second /api/getToken request.
     *
     * force=true  — planned refresh (timer / visibilitychange / init).
     *               Always initiates a new call when no refresh is in-flight,
     *               but still joins an existing one if there is.
     * force=false — 401-retry path. Same deduplication behaviour; the parameter
     *               is accepted so all call-sites use a uniform signature.
     * Note: when a refresh is already in-flight, force has no effect — all callers join the existing promise.
     */
    const ensureFreshToken = async ({ force: _force = false }: { force?: boolean } = {}): Promise<void> => {
      if (!reinitInFlight) {
        reinitInFlight = reinitToken().finally(() => {
          reinitInFlight = null
        })
      }
      return reinitInFlight
    }

    const baseFetch = $fetch.create({ baseURL: apiUrl })

    /**
     * Wrapper around $fetch that transparently re-issues the JWT on 401 and
     * retries the original request once. Token-issuance endpoints
     * (/api/getToken, /api/install) bypass the wrapper to avoid recursion.
     *
     * Without this wrapper, after the 1h JWT TTL the next API call would
     * throw, breaking any open admin/reviewer screen until the user reloads.
     */
    type ApiFetchOptions = NonNullable<Parameters<typeof baseFetch>[1]> & {
      _retried?: boolean
    }
    const getFetchStatus = (error: unknown): number => {
      if (!error || typeof error !== 'object') {
        return 0
      }
      const payload = error as {
        response?: { status?: number }
        status?: number
      }
      return Number(payload.response?.status ?? payload.status ?? 0)
    }

    const $api = (async <T = unknown>(request: string, options: ApiFetchOptions = {}): Promise<T> => {
      const url = String(request || '')
      const isAuthEndpoint = url.includes('/api/getToken') || url.includes('/api/install')

      try {
        return await baseFetch<T>(request, options)
      } catch (error: unknown) {
        const status = getFetchStatus(error)
        if (status !== 401 || isAuthEndpoint || options._retried) {
          throw error
        }
        await ensureFreshToken()
        const retryHeaders = {
          ...(options.headers || {}),
          Authorization: `Bearer ${tokenJWT.value}`
        }
        return await baseFetch<T>(request, {
          ...options,
          headers: retryHeaders,
          _retried: true
        })
      }
    }) as typeof baseFetch

    // Health check
    const checkHealth = async (): Promise<{
      status: string
      backend: string
      timestamp: number
      role?: AppRole | null
      capabilities?: Partial<AppCapabilities> | null
    }> => {
      return await $api('/api/health', {
        headers: {
          Authorization: `Bearer ${tokenJWT.value}`
        }
      })
    }

    const getSettings = async (): Promise<{
      settings: JsonObject
      defaults: JsonObject
    }> => {
      return await $api('/api/settings', {
        headers: {
          Authorization: `Bearer ${tokenJWT.value}`
        }
      })
    }

    const saveSettings = async (settings: JsonObject): Promise<{
      settings: JsonObject
    }> => {
      return await $api('/api/settings', {
        method: 'PUT',
        body: { settings },
        headers: {
          Authorization: `Bearer ${tokenJWT.value}`
        }
      })
    }

    const refreshBotAvatar = async (): Promise<{
      ok: boolean
      botId: number
      reused: boolean
      registered: boolean
    }> => {
      return await $api('/api/admin/bot/refresh-avatar', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenJWT.value}`
        }
      })
    }

    const reregisterBot = async (): Promise<{
      ok: boolean
      botId: number
      registered: boolean
      reused: boolean
    }> => {
      return await $api('/api/admin/bot/reregister', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenJWT.value}`
        }
      })
    }

    const getReports = async (filters: {
      dateFrom?: string
      dateTo?: string
      status?: string
      azsId?: string
      limit?: number
    } = {}): Promise<{ items: ReportRow[]; total: number }> => {
      return await $api('/api/reports', {
        query: filters,
        headers: {
          Authorization: `Bearer ${tokenJWT.value}`
        }
      })
    }

    const getReportsSummary = async (filters: {
      dateFrom?: string
      dateTo?: string
      azsId?: string
    } = {}): Promise<{ summary: ReportsSummary }> => {
      return await $api('/api/reports/summary', {
        query: filters,
        headers: {
          Authorization: `Bearer ${tokenJWT.value}`
        }
      })
    }

    const getReportById = async (id: number): Promise<{
      item: ReportRow
      photos?: Array<{ photoCode: string }>
      requiredPhotos?: Array<{ code: string; title: string; sort?: number }>
    }> => {
      return await $api(`/api/reports/${id}`, {
        headers: {
          Authorization: `Bearer ${tokenJWT.value}`
        }
      })
    }

    const getMyActiveReport = async (limit = 20): Promise<{
      item: ReportRow | null
      items: ReportRow[]
      total: number
    }> => {
      return await $api('/api/reports/my-active', {
        query: { limit },
        headers: {
          Authorization: `Bearer ${tokenJWT.value}`
        }
      })
    }

    const getAzsOptions = async (filters: {
      search?: string
      limit?: number
    } = {}): Promise<{ items: AzsOption[] }> => {
      return await $api('/api/reports/azs-options', {
        query: filters,
        headers: {
          Authorization: `Bearer ${tokenJWT.value}`
        }
      })
    }

    const createManualReport = async (payload: {
      candidates?: JsonObject[]
      azsIds?: string[]
      slotDate?: string
      slotHHmm?: string
    }): Promise<{
      summary: JsonObject
      items: JsonObject[]
    }> => {
      return await $api('/api/reports/manual', {
        method: 'POST',
        body: payload,
        headers: {
          Authorization: `Bearer ${tokenJWT.value}`
        }
      })
    }

    const uploadReportPhoto = async ({
      reportId,
      photoCode,
      file
    }: {
      reportId: number
      photoCode: string
      file: File
    }): Promise<{ item: JsonObject }> => {
      const form = new FormData()
      form.append('photo', file)
      form.append('photoCode', photoCode)

      return await $api(`/api/reports/${reportId}/photo`, {
        method: 'POST',
        body: form,
        headers: {
          Authorization: `Bearer ${tokenJWT.value}`
        }
      })
    }

    const submitReport = async (reportId: number): Promise<{ item: JsonObject }> => {
      return await $api(`/api/reports/${reportId}/submit`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenJWT.value}`
        }
      })
    }

    const runTimeoutWatcher = async (limit = 200): Promise<{
      summary: JsonObject
    }> => {
      return await $api('/api/jobs/timeout', {
        method: 'POST',
        body: { limit },
        headers: {
          Authorization: `Bearer ${tokenJWT.value}`
        }
      })
    }

    const resyncReport = async (reportId: number): Promise<{ ok: boolean; syncQueued: boolean }> => {
      return await $api(`/api/reports/${reportId}/resync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenJWT.value}` }
      })
    }

    const getDispatchPlan = async (date?: string): Promise<{
      items: Array<{
        azsId: string
        azsTitle: string
        adminUserId: number
        baseTime: string
        executeAt: string
        status: string
        reportItemId: number | null
      }>
      planDate: string | null
      enabled: boolean
    }> => {
      const query = date ? { date } : {}
      return await $api('/api/reports/plan', { query, headers: { Authorization: `Bearer ${tokenJWT.value}` } })
    }

    const generateDispatchPlan = async (date?: string): Promise<{ ok: boolean; planDate: string; azsCount: number; planned: number | null }> => {
      return await $api('/api/reports/plan/generate', { method: 'POST', body: date ? { date } : {}, headers: { Authorization: `Bearer ${tokenJWT.value}` } })
    }

    const postInstall = async (data: JsonObject): Promise<JsonObject> => {
      return await $api('/api/install', {
        method: 'POST',
        body: data,
      })
    }

    const getToken = async (data: JsonObject): Promise<{ token: string }> => {
      return await $api('/api/getToken', {
        method: 'POST',
        body: data,
      })
    }

    const getMyRole = async (): Promise<{
      role: AppRole
      capabilities: AppCapabilities
      access?: {
        adminUserIds: number[]
        reviewerUserIds: number[]
        azsAdminUserIds: number[]
      }
    }> => {
      return await $api('/api/me/role', {
        headers: {
          Authorization: `Bearer ${tokenJWT.value}`
        }
      })
    }

    const getReportsRating = async (filters: { dateFrom?: string; dateTo?: string; azsId?: string } = {}): Promise<{ items: RatingRow[] }> =>
      await $api('/api/reports/analytics/rating', { query: filters, headers: { Authorization: `Bearer ${tokenJWT.value}` } })

    const getReportsTrend = async (filters: { dateFrom?: string; dateTo?: string; azsId?: string } = {}): Promise<{ items: TrendRow[] }> =>
      await $api('/api/reports/analytics/trend', { query: filters, headers: { Authorization: `Bearer ${tokenJWT.value}` } })

    const getDayPhotos = async (filters: { date?: string; azsId?: string } = {}): Promise<{ items: DayPhotoEntry[]; date: string }> =>
      await $api('/api/reports/analytics/day-photos', { query: filters, headers: { Authorization: `Bearer ${tokenJWT.value}` } })

    const submitReason = async (reportId: number, payload: {
      reasonCode: string
      reasonText?: string | null
    }): Promise<{ ok: boolean; reportId: number; reasonCode: string; reasonText: string | null }> => {
      return await $api(`/api/reports/${reportId}/reason`, {
        method: 'POST',
        body: payload,
        headers: { Authorization: `Bearer ${tokenJWT.value}` }
      })
    }

    const getReasonCounts = async (filters: {
      dateFrom?: string
      dateTo?: string
      azsId?: string
    } = {}): Promise<{ items: ReasonItem[]; total: number }> => {
      return await $api('/api/reports/reasons', {
        query: filters,
        headers: { Authorization: `Bearer ${tokenJWT.value}` }
      })
    }

    type PhotoFeedItem = {
      reportId: number
      azsId: string
      azsTitle?: string | null
      photoCode: string
      exifAt: string | null
      uploadedAt: string | null
      remark: { createdAt: string | null; recipientName: string; message: string; senderName: string } | null
    }

    type PhotoCategory = {
      code: string
      title: string
    }

    type PhotoRecipients = {
      manager: { id: number; name: string } | null
      admin: { id: number; name: string } | null
    }

    const getPhotoFeed = async (params: {
      dateFrom?: string
      dateTo?: string
      azsId?: string[]
      photoCode?: string[]
      remarks?: 'all' | 'with' | 'without'
      limit?: number
      cursor?: string
    } = {}): Promise<{ items: PhotoFeedItem[]; nextCursor: string | null }> => {
      return await $api('/api/reports/photos/feed', {
        query: params,
        headers: { Authorization: `Bearer ${tokenJWT.value}` }
      })
    }

    const getPhotoCategories = async (): Promise<{ items: PhotoCategory[] }> => {
      return await $api('/api/reports/photos/categories', {
        headers: { Authorization: `Bearer ${tokenJWT.value}` }
      })
    }

    const getPhotoRecipients = async (azsId: string): Promise<PhotoRecipients> => {
      return await $api('/api/reports/photos/recipients', {
        query: { azsId },
        headers: { Authorization: `Bearer ${tokenJWT.value}` }
      })
    }

    type PhotoRemarkRecord = {
      id: number
      createdAt: string
      azsId: string
      azsTitle: string | null
      recipientRole: 'manager' | 'admin'
      recipientName: string
      message: string
      senderName: string
      deliveryStatus: 'sent' | 'failed'
      deliveryError: string | null
    }

    const sendPhotoRemark = async (payload: {
      azsId: string
      azsTitle?: string | null
      recipientRole: 'manager' | 'admin'
      message: string
      photos: Array<{ reportId: number; photoCode: string }>
    }): Promise<{ item: PhotoRemarkRecord }> => {
      return await $api('/api/photo-remarks', {
        method: 'POST',
        body: payload,
        headers: { Authorization: `Bearer ${tokenJWT.value}` }
      })
    }

    type PhotoRemarkJournalItem = {
      id: number
      createdAt: string | null
      azsId: string
      azsTitle: string | null
      recipientRole: 'manager' | 'admin'
      recipientName: string | null
      message: string
      senderName: string | null
      deliveryStatus: 'sent' | 'failed'
      deliveryError: string | null
      photos: Array<{ remarkId: number; reportId: number; photoCode: string }>
    }

    const getPhotoRemarks = async (params: {
      dateFrom?: string
      dateTo?: string
      azsIds?: string[]
      limit?: number
      cursor?: string
    } = {}): Promise<{ items: PhotoRemarkJournalItem[]; nextCursor: string | null }> => {
      const query: Record<string, unknown> = {}
      if (params.dateFrom) query.dateFrom = params.dateFrom
      if (params.dateTo) query.dateTo = params.dateTo
      if (params.azsIds && params.azsIds.length > 0) query.azsId = params.azsIds
      if (params.limit) query.limit = params.limit
      if (params.cursor) query.cursor = params.cursor
      return await $api('/api/photo-remarks', {
        query,
        headers: { Authorization: `Bearer ${tokenJWT.value}` }
      })
    }

    const retryPhotoRemark = async (id: number): Promise<PhotoRemarkJournalItem> => {
      const resp = await $api<{ item: PhotoRemarkJournalItem }>(`/api/photo-remarks/${id}/retry`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenJWT.value}` }
      })
      return resp.item
    }

    const getPhotoPreviewObjectUrl = async (reportId: number, photoCode: string): Promise<string> => {
      const blob = await $fetch(`${apiUrl}/api/reports/photos/${reportId}/${encodeURIComponent(photoCode)}/preview`, {
        headers: { Authorization: `Bearer ${tokenJWT.value}` },
        responseType: 'blob'
      }) as Blob
      return URL.createObjectURL(blob)
    }

    const init = async (b24: B24Frame) => {
      $b24 = b24
      await ensureFreshToken({ force: true })
    }

    const reinitToken = async () => {
      if ($b24 === null) {
        console.error('B24 non init. Use api.init()')
        return
      }

      const authData = $b24.auth.getAuthData()

      if(authData === false) {
        throw new Error('Some problem with auth. See App logic')
      }

      const user = useUserStore()
      const appSettings = useAppSettingsStore()
      const authUserData = authData as { user_id?: number; userId?: number }
      const userId = Number(user.id || authUserData.user_id || authUserData.userId || 0)

      const response = await getToken({
        DOMAIN: withoutTrailingSlash(authData.domain).replace('https://', '').replace('http://', ''),
        PROTOCOL: authData.domain.includes('https://') ? 1 : 0,
        LANG: $b24.getLang(),
        APP_SID: $b24.getAppSid(),
        AUTH_ID: authData.access_token,
        AUTH_EXPIRES: authData.expires_in,
        REFRESH_ID: authData.refresh_token,
        REFRESH_TOKEN: authData.refresh_token,
        member_id: authData.member_id,
        user_id: userId,
        is_admin: user.isAdmin ? 'Y' : 'N',
        status: appSettings.status
      })

      tokenJWT.value = response.token
    }

    return {
      tokenJWT,
      isInitTokenJWT,
      checkHealth,
      init,
      ensureFreshToken,
      getSettings,
      getReports,
      getReportsSummary,
      getReportById,
      getMyActiveReport,
      postInstall,
      createManualReport,
      getAzsOptions,
      runTimeoutWatcher,
      uploadReportPhoto,
      submitReport,
      saveSettings,
      refreshBotAvatar,
      reregisterBot,
      getMyRole,
      resyncReport,
      getDispatchPlan,
      generateDispatchPlan,
      getReportsRating,
      getReportsTrend,
      getDayPhotos,
      getPhotoPreviewObjectUrl,
      submitReason,
      getReasonCounts,
      getPhotoFeed,
      getPhotoCategories,
      getPhotoRecipients,
      sendPhotoRemark,
      getPhotoRemarks,
      retryPhotoRemark
    }
  }
)
