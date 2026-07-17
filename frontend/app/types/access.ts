export type AppRole = 'admin' | 'reviewer' | 'azs_admin'

export type AppCapabilities = {
  settings: boolean
  reviewer: boolean
  reports: boolean
}
