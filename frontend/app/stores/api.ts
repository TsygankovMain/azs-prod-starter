import type { B24Frame } from '@bitrix24/b24jssdk'
import { withoutTrailingSlash } from 'ufo'

type JsonObject = Record<string, unknown>

type ReportRow = {
  id: number
  slotKey: string
  azsId: string
  adminUserId: number
  status: string
  reportItemId: number | null
  jitterMinutes: number | null
  scheduledAt: string | null
  deadlineAt: string | null
  errorText: string | null
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

    const $api = $fetch.create({
      baseURL: apiUrl
    })

    // Health check
    const checkHealth = async (): Promise<{
      status: string
      backend: string
      timestamp: number
    }> => {
      try {
        return await $api('/api/health', {
          headers: {
            Authorization: `Bearer ${tokenJWT.value}`
          }
        })
      } catch {
        throw new Error('Backend health check failed')
      }
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

    const createManualReport = async (candidate: JsonObject): Promise<{
      summary: JsonObject
      items: JsonObject[]
    }> => {
      return await $api('/api/reports/manual', {
        method: 'POST',
        body: { candidate },
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

    const init = async (b24: B24Frame) => {
      $b24 = b24
      await reinitToken()
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
        user_id: user.id,
        status: appSettings.status
      })

      tokenJWT.value = response.token
    }

    return {
      tokenJWT,
      isInitTokenJWT,
      checkHealth,
      init,
      getSettings,
      getReports,
      getReportsSummary,
      getReportById,
      postInstall,
      createManualReport,
      runTimeoutWatcher,
      uploadReportPhoto,
      saveSettings,
    }
  }
)
