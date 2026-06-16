<script setup lang="ts">
import type { B24Frame } from '@bitrix24/b24jssdk'
import type { BrandItem } from '~/stores/api'

const PAGE_TITLE = 'Бренды — внешний доступ к фото'

useHead({ title: PAGE_TITLE })

const { locales: localesI18n, setLocale } = useI18n()
const { initApp, processErrorGlobal, destroyB24Helper, b24Helper } = useAppInit('BrandsPage')
const { $initializeB24Frame } = useNuxtApp()
const apiStore = useApiStore()
const toast = useAppToast()
const { confirm } = useConfirm()

let $b24: null | B24Frame = null

// ─── Types ────────────────────────────────────────────────────────────────────
// BrandItem импортируется из ~/stores/api

type AzsOption = {
  value: string
  label: string
}

// ─── Access gate ──────────────────────────────────────────────────────────────

const isAdminReady = ref(false)
const isLoading = ref(false)
const loadError = ref('')

// ─── Data ─────────────────────────────────────────────────────────────────────

const brands = ref<BrandItem[]>([])
const azsOptions = ref<AzsOption[]>([])

// ─── Create brand form ────────────────────────────────────────────────────────

const newBrandName = ref('')
const isCreating = ref(false)

// ─── Per-brand edit state ─────────────────────────────────────────────────────

type BrandEditState = {
  name: string
  azsIds: string[]
  isRenameSaving: boolean
  isAzsSaving: boolean
  isDeleting: boolean
  isLinkLoading: boolean
  link: string
  linkCopied: boolean
  showLinkBox: boolean
}

const editState = ref<Record<number, BrandEditState>>({})

/**
 * Мутирующая инициализация — вызывается только из JS-кода (lifecycle, actions).
 * В шаблоне НЕ используется.
 */
function ensureEditState(brand: BrandItem) {
  if (!editState.value[brand.id]) {
    editState.value[brand.id] = {
      name: brand.name,
      azsIds: [...brand.azsIds],
      isRenameSaving: false,
      isAzsSaving: false,
      isDeleting: false,
      isLinkLoading: false,
      link: brand.externalLink ?? '',
      linkCopied: false,
      showLinkBox: Boolean(brand.externalLink)
    }
  }
  return editState.value[brand.id]
}

/**
 * Безопасный геттер без мутации — для использования в шаблоне.
 * Возвращает undefined если состояние ещё не инициализировано.
 */
function getBrandState(brandId: number): BrandEditState | undefined {
  return editState.value[brandId]
}

// ─── disabledAzsIds per brand: АЗС, занятые ДРУГИМИ брендами ─────────────────

function getDisabledAzsIds(brandId: number): string[] {
  const result: string[] = []
  for (const b of brands.value) {
    if (b.id === brandId) continue
    for (const id of b.azsIds) {
      result.push(id)
    }
  }
  return result
}

// ─── Load ─────────────────────────────────────────────────────────────────────

async function loadBrands() {
  loadError.value = ''
  try {
    const resp = await apiStore.listBrands()
    brands.value = resp.items ?? []
    // Инициализируем/синхронизируем editState для всех брендов после загрузки,
    // чтобы шаблон мог обращаться к editState[brand.id] без мутирующих вызовов.
    for (const brand of brands.value) {
      if (editState.value[brand.id]) {
        // keep user edits in name/azsIds but refresh link from server
        editState.value[brand.id].link = brand.externalLink ?? ''
        if (!editState.value[brand.id].showLinkBox && brand.externalLink) {
          editState.value[brand.id].showLinkBox = true
        }
      } else {
        editState.value[brand.id] = {
          name: brand.name,
          azsIds: [...brand.azsIds],
          isRenameSaving: false,
          isAzsSaving: false,
          isDeleting: false,
          isLinkLoading: false,
          link: brand.externalLink ?? '',
          linkCopied: false,
          showLinkBox: Boolean(brand.externalLink)
        }
      }
    }
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : 'Не удалось загрузить список брендов'
  }
}

async function loadAzsOptions() {
  try {
    const resp = await apiStore.getAzsOptions({ limit: 500 })
    azsOptions.value = resp.items.map(i => ({
      value: String(i.id || '').trim(),
      label: String(i.title || `АЗС ${i.id}`).trim()
    }))
  } catch {
    // non-critical — AzsMultiSelect loads itself if options prop empty
  }
}

// ─── Create brand ─────────────────────────────────────────────────────────────

async function createBrand() {
  const name = newBrandName.value.trim()
  if (!name) {
    toast.warning('Введите название бренда')
    return
  }
  isCreating.value = true
  try {
    const resp = await apiStore.createBrand(name)
    brands.value.push(resp.item)
    ensureEditState(resp.item)
    newBrandName.value = ''
    toast.success(`Бренд «${resp.item.name}» создан`)
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Не удалось создать бренд'
    toast.error(msg)
  } finally {
    isCreating.value = false
  }
}

// ─── Rename brand ─────────────────────────────────────────────────────────────

async function renameBrand(brand: BrandItem) {
  const state = ensureEditState(brand)
  const name = state.name.trim()
  if (!name) {
    toast.warning('Название не может быть пустым')
    return
  }
  if (name === brand.name) {
    toast.info('Название не изменилось')
    return
  }
  state.isRenameSaving = true
  try {
    const resp = await apiStore.updateBrand(brand.id, name)
    const idx = brands.value.findIndex(b => b.id === brand.id)
    if (idx !== -1) brands.value[idx] = resp.item
    toast.success(`Переименовано в «${resp.item.name}»`)
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Не удалось переименовать бренд'
    toast.error(msg)
  } finally {
    state.isRenameSaving = false
  }
}

// ─── Save AZS assignment ──────────────────────────────────────────────────────

async function saveAzs(brand: BrandItem) {
  const state = ensureEditState(brand)
  state.isAzsSaving = true
  try {
    const resp = await apiStore.setBrandAzs(brand.id, state.azsIds)
    const idx = brands.value.findIndex(b => b.id === brand.id)
    if (idx !== -1) brands.value[idx] = resp.item
    // Синхронизируем editState нормализованным составом от сервера
    editState.value[brand.id].azsIds = [...resp.item.azsIds]
    toast.success(`Состав АЗС бренда «${brand.name}» сохранён`)
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Не удалось сохранить состав АЗС'
    toast.error(msg)
  } finally {
    state.isAzsSaving = false
  }
}

// ─── Delete brand ─────────────────────────────────────────────────────────────

async function deleteBrand(brand: BrandItem) {
  const state = ensureEditState(brand)
  const ok = await confirm({
    title: `Удалить бренд «${brand.name}»?`,
    text: `АЗС бренда будут откреплены. Папка на Диске и ссылка останутся — удалите их вручную при необходимости.`,
    confirmLabel: 'Удалить'
  })
  if (!ok) return
  state.isDeleting = true
  try {
    const deletedId = brand.id
    await apiStore.deleteBrand(deletedId)
    brands.value = brands.value.filter(b => b.id !== deletedId)
    editState.value = Object.fromEntries(
      Object.entries(editState.value).filter(([k]) => Number(k) !== deletedId)
    )
    toast.success(`Бренд «${brand.name}» удалён`)
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Не удалось удалить бренд'
    toast.error(msg)
  } finally {
    const st = editState.value[brand.id]
    if (st) {
      st.isDeleting = false
    }
  }
}

// ─── External link ────────────────────────────────────────────────────────────

async function getExternalLink(brand: BrandItem) {
  const state = ensureEditState(brand)
  state.isLinkLoading = true
  state.linkCopied = false
  try {
    const resp = await apiStore.getBrandExternalLink(brand.id)
    state.link = resp.link
    state.showLinkBox = true
    // persist link into brands list so it survives re-render
    const idx = brands.value.findIndex(b => b.id === brand.id)
    if (idx !== -1) brands.value[idx] = { ...brands.value[idx], externalLink: resp.link }
    toast.success('Ссылка получена')
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Не удалось получить ссылку'
    toast.error(msg)
  } finally {
    state.isLinkLoading = false
  }
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  // navigator.clipboard часто недоступен внутри iframe Bitrix24 (нет clipboard-write
  // permission / небезопасный контекст) — поэтому делаем fallback на execCommand.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // переходим к fallback
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

async function copyLink(brandId: number) {
  const state = editState.value[brandId]
  if (!state?.link) return
  const ok = await copyTextToClipboard(state.link)
  if (ok) {
    state.linkCopied = true
    setTimeout(() => { if (editState.value[brandId]) editState.value[brandId].linkCopied = false }, 2000)
  } else {
    toast.error('Не удалось скопировать ссылку — скопируйте вручную')
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(async () => {
  try {
    isLoading.value = true
    $b24 = await $initializeB24Frame()
    await initApp($b24, localesI18n, setLocale)
    await $b24.parent.setTitle(PAGE_TITLE)

    // Role check
    try {
      const role = await apiStore.getMyRole()
      isAdminReady.value = Boolean(role.capabilities?.settings)
    } catch {
      // portal-admin fallback
      const userStore = useUserStore()
      if (userStore.isAdmin) {
        isAdminReady.value = true
      }
    }

    if (isAdminReady.value) {
      await Promise.all([loadBrands(), loadAzsOptions()])
    }
  } catch (error) {
    processErrorGlobal(error)
  } finally {
    isLoading.value = false
  }
})

onUnmounted(() => {
  if (b24Helper.value) destroyB24Helper()
})
</script>

<template>
  <div class="mx-auto flex w-full max-w-[1200px] flex-col gap-4 p-4 pb-24">
    <!-- Header -->
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex min-w-0 items-start gap-3">
        <B24Button
          color="air-secondary"
          label="Назад"
          @click="$router.push('/')"
        />
        <div class="min-w-0">
          <ProseH2 class="mb-1">
            Бренды — внешний доступ к фото
          </ProseH2>
          <ProseP class="mb-0 max-w-[760px] text-sm text-(--ui-color-base-70)">
            Объедините АЗС в бренд, получите внешнюю ссылку на папку Bitrix Диска и передайте её партнёру.
          </ProseP>
        </div>
      </div>
      <B24Badge
        rounded
        size="md"
        :color="isAdminReady ? 'air-primary-success' : 'air-primary-alert'"
        inverted
        :label="isAdminReady ? 'роль: администратор' : 'нет доступа'"
      />
    </div>

    <!-- Access denied -->
    <B24Alert
      v-if="!isLoading && !isAdminReady"
      color="air-primary-alert"
      title="Нет доступа"
      description="Управление брендами доступно только администратору приложения."
    />

    <!-- Load error -->
    <B24Alert
      v-if="loadError"
      color="air-primary-alert"
      title="Не удалось загрузить бренды"
      :description="loadError"
    />

    <template v-if="isAdminReady">
      <!-- Create brand -->
      <B24Card>
        <template #header>
          <ProseH3 class="mb-0">
            Создать бренд
          </ProseH3>
        </template>
        <div class="flex gap-2">
          <B24Input
            v-model="newBrandName"
            class="flex-1"
            placeholder="Например: ГПН Москва"
            :disabled="isCreating"
            @keydown.enter="createBrand"
          />
          <B24Button
            color="air-primary"
            label="Создать"
            :loading="isCreating"
            loading-auto
            @click="createBrand"
          />
        </div>
      </B24Card>

      <!-- Brand list -->
      <div v-if="isLoading" class="space-y-3">
        <SkeletonBlock
          v-for="n in 2"
          :key="n"
          height="120px"
          rounded="rounded-xl"
        />
      </div>

      <div v-else-if="brands.length === 0 && !loadError" class="text-sm text-(--ui-color-base-50) py-4 text-center">
        Брендов пока нет — создайте первый выше.
      </div>

      <B24Card
        v-for="brand in brands"
        :key="brand.id"
        class="space-y-5"
      >
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2 flex-wrap">
              <ProseH3 class="mb-0">
                {{ brand.name }}
              </ProseH3>
              <B24Badge
                color="air-secondary"
                rounded
                size="sm"
                :label="`${brand.azsIds.length} АЗС`"
              />
              <B24Badge
                v-if="brand.externalLink"
                color="air-primary-success"
                rounded
                size="sm"
                label="ссылка есть"
              />
            </div>
            <B24Button
              color="air-primary-alert"
              variant="ghost"
              size="sm"
              label="Удалить бренд"
              :loading="getBrandState(brand.id)?.isDeleting"
              loading-auto
              @click="deleteBrand(brand)"
            />
          </div>
        </template>

        <!-- Rename -->
        <div>
          <p class="mb-1 text-xs font-semibold uppercase tracking-wide text-(--ui-color-base-50)">
            Название
          </p>
          <div class="flex gap-2">
            <B24Input
              v-model="editState[brand.id].name"
              class="flex-1"
              placeholder="Название бренда"
            />
            <B24Button
              color="air-secondary"
              size="sm"
              label="Сохранить"
              :loading="getBrandState(brand.id)?.isRenameSaving"
              loading-auto
              @click="renameBrand(brand)"
            />
          </div>
        </div>

        <!-- AZS assignment -->
        <div>
          <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-(--ui-color-base-50)">
            АЗС бренда
          </p>
          <AzsMultiSelect
            v-model="editState[brand.id].azsIds"
            :options="azsOptions.length ? azsOptions : undefined"
            :disabled-azs-ids="getDisabledAzsIds(brand.id)"
            label="АЗС"
            placeholder="Нет выбранных АЗС"
          />
          <div class="mt-2 flex items-center gap-2">
            <B24Button
              color="air-primary"
              size="sm"
              label="Сохранить состав АЗС"
              :loading="getBrandState(brand.id)?.isAzsSaving"
              loading-auto
              @click="saveAzs(brand)"
            />
            <ProseP class="mb-0 text-xs text-(--ui-color-base-50)">
              АЗС с меткой «занята» уже принадлежат другому бренду — перенос разрешён.
            </ProseP>
          </div>
        </div>

        <!-- Disk folder info -->
        <div v-if="brand.diskFolderId" class="text-xs text-(--ui-color-base-50)">
          Папка Диска: ID {{ brand.diskFolderId }}
          <span v-if="brand.diskFolderPath"> — {{ brand.diskFolderPath }}</span>
        </div>

        <!-- External link -->
        <div>
          <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-(--ui-color-base-50)">
            Внешняя ссылка
          </p>

          <!-- Link box -->
          <div
            v-if="getBrandState(brand.id)?.showLinkBox && getBrandState(brand.id)?.link"
            class="mb-3 rounded-lg border border-(--ui-color-base-20) bg-(--ui-color-base-5) p-3 space-y-2"
          >
            <div class="flex gap-2 items-center flex-wrap">
              <code class="flex-1 break-all text-xs text-(--ui-color-base-80) select-all">{{ getBrandState(brand.id)?.link }}</code>
              <B24Button
                :color="getBrandState(brand.id)?.linkCopied ? 'air-primary-success' : 'air-secondary'"
                size="xs"
                :label="getBrandState(brand.id)?.linkCopied ? 'Скопировано!' : 'Скопировать'"
                @click="copyLink(brand.id)"
              />
            </div>
            <p v-if="brand.externalLinkUpdatedAt" class="text-[11px] text-(--ui-color-base-40)">
              Обновлено: {{ brand.externalLinkUpdatedAt }}
            </p>
          </div>

          <!-- Actions -->
          <div class="flex flex-wrap gap-2 items-start">
            <B24Button
              :color="getBrandState(brand.id)?.link ? 'air-secondary' : 'air-primary'"
              size="sm"
              :label="getBrandState(brand.id)?.link ? 'Обновить ссылку' : 'Получить ссылку'"
              :loading="getBrandState(brand.id)?.isLinkLoading"
              loading-auto
              @click="getExternalLink(brand)"
            />
          </div>

          <!-- Password hint (Вариант A) -->
          <B24Alert
            class="mt-3"
            color="air-secondary"
            title="Пароль и срок действия"
            description="Пароль и срок действия ссылки настраиваются вручную в Bitrix Диске: откройте папку бренда → «Поделиться» → «Публичная ссылка» → «Настройки». REST API Bitrix24 управления паролем не поддерживает."
          />
        </div>
      </B24Card>
    </template>
  </div>
</template>
