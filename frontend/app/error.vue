<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{
  error: NuxtError
}>()

useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [],
  htmlAttrs: { lang: 'en' }
})

const friendlyMessage = computed(() => {
  const raw = String(props.error?.message ?? '')
  if (raw.includes('Unable to initialize Bitrix24Frame')) {
    return 'Приложение нужно открывать из портала Битрикс24.'
  }
  if (props.error?.statusCode === 404) return 'Страница не найдена.'
  return 'Не удалось загрузить приложение. Проверьте соединение и попробуйте ещё раз.'
})

const technicalDetail = computed(() => {
  const parts: string[] = []
  if (props.error?.statusCode) parts.push(`Код: ${props.error.statusCode}`)
  if (props.error?.message) parts.push(props.error.message)
  return parts.join(' · ')
})

const reload = () => {
  window.location.reload()
}
</script>

<template>
  <B24App>
    <NuxtLoadingIndicator color="var(--ui-color-accent-main-primary)" :height="2" />

    <B24SidebarLayout :use-light-content="false">
      <B24Card class="mt-[2px]">
        <div class="flex flex-col gap-4">
          <B24Alert
            color="air-primary-alert"
            title="Ошибка"
            :description="friendlyMessage"
          />

          <div class="flex justify-start">
            <B24Button
              color="air-primary"
              variant="solid"
              label="Обновить"
              @click="reload"
            />
          </div>

          <details class="text-xs text-gray-400">
            <summary class="cursor-pointer hover:text-gray-600 select-none">Подробности</summary>
            <p class="mt-1 font-mono break-all">{{ technicalDetail }}</p>
          </details>
        </div>
      </B24Card>
    </B24SidebarLayout>
  </B24App>
</template>
