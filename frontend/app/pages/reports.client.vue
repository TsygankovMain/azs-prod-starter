<script setup lang="ts">
import type { B24Frame } from '@bitrix24/b24jssdk'

const PAGE_TITLE = 'Отчёты АЗС'
useHead({ title: PAGE_TITLE })

const { locales: localesI18n, setLocale } = useI18n()
const { initApp, processErrorGlobal } = useAppInit('ReportsPage')
const { $initializeB24Frame } = useNuxtApp()
const apiStore = useApiStore()

type ReportTab = 'r1' | 'r2' | 'r3' | 'r4' | 'r5'
const activeTab = ref<ReportTab>('r1')

const hasAccess = ref(false)
const accessError = ref('')

let $b24: null | B24Frame = null

onMounted(async () => {
  try {
    $b24 = await $initializeB24Frame()
    await initApp($b24, localesI18n, setLocale)
    const roleResp = await apiStore.getMyRole()
    hasAccess.value = Boolean(
      roleResp.capabilities?.reviewer || roleResp.capabilities?.settings || roleResp.capabilities?.reports
    )
    if (!hasAccess.value) {
      accessError.value = 'Недостаточно прав для просмотра отчётов'
      return
    }
    await $b24.parent.setTitle(PAGE_TITLE)
  } catch (e) {
    processErrorGlobal(e)
  }
})
</script>

<template>
  <div class="w-full bg-[#eef1f4] min-h-screen">
    <B24Alert v-if="accessError" color="air-primary-alert" :description="accessError" class="m-4" />
    <template v-else-if="hasAccess">
      <div class="flex min-h-screen">
        <ReportNav v-model:active="activeTab" class="hidden lg:block" />
        <main class="flex-1 p-6 max-w-[1180px] mx-auto w-full pb-24 lg:pb-6">
          <R1Summary v-if="activeTab === 'r1'" />
          <R2Rating  v-else-if="activeTab === 'r2'" />
          <R3Trend   v-else-if="activeTab === 'r3'" />
          <R4Card    v-else-if="activeTab === 'r4'" />
          <R5Wall    v-else-if="activeTab === 'r5'" />
        </main>
        <!-- Мобильная нижняя навигация -->
        <ReportNav v-model:active="activeTab" :mobile="true" class="lg:hidden" />
      </div>
    </template>
  </div>
</template>
