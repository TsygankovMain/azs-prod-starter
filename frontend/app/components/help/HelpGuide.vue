<script setup lang="ts">
import { ref, watch } from 'vue'
import MockupAdminReport from './MockupAdminReport.vue'
import MockupReviewerDashboard from './MockupReviewerDashboard.vue'
import MockupSettings from './MockupSettings.vue'
import MockupPushNotification from './MockupPushNotification.vue'

const { isOpen, defaultRole, close } = useHelpDrawer()

const activeTab = ref<'admin' | 'reviewer' | 'settings'>('admin')

watch(() => defaultRole.value, (newRole) => {
  activeTab.value = newRole
})

const handleBackdropClick = () => {
  close()
}

const handleCloseClick = () => {
  close()
}
</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 z-40">
    <!-- Backdrop overlay -->
    <div
      class="absolute inset-0 bg-black/20"
      @click="handleBackdropClick"
    />

    <!-- Right-side panel -->
    <div class="absolute right-0 top-0 bottom-0 w-full max-w-[720px] bg-white shadow-lg flex flex-col z-50">
      <!-- Header with close button -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200">
        <ProseH3 class="m-0">Справочник</ProseH3>
        <button
          type="button"
          class="inline-flex items-center justify-center w-8 h-8 rounded hover:bg-gray-100 transition-colors"
          aria-label="Закрыть"
          @click="handleCloseClick"
        >
          <span class="text-2xl leading-none">&times;</span>
        </button>
      </div>

      <!-- Tabs and content -->
      <div class="flex-1 overflow-hidden flex flex-col">
        <!-- Tab buttons -->
        <div class="flex border-b border-gray-200 px-6 bg-white">
          <button
            type="button"
            class="px-4 py-3 font-medium text-sm transition-colors"
            :class="activeTab === 'admin' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-600 hover:text-gray-900'"
            @click="activeTab = 'admin'"
          >
            Администратор АЗС
          </button>
          <button
            type="button"
            class="px-4 py-3 font-medium text-sm transition-colors"
            :class="activeTab === 'reviewer' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-600 hover:text-gray-900'"
            @click="activeTab = 'reviewer'"
          >
            Управляющий
          </button>
          <button
            type="button"
            class="px-4 py-3 font-medium text-sm transition-colors"
            :class="activeTab === 'settings' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-600 hover:text-gray-900'"
            @click="activeTab = 'settings'"
          >
            Настройки
          </button>
        </div>

        <!-- Scrollable content area -->
        <div class="flex-1 overflow-y-auto">
          <!-- Admin tab -->
          <div v-if="activeTab === 'admin'" class="px-6 py-4 space-y-4">
            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Зачем это нужно</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Ежедневный фото-отчёт позволяет управляющему видеть состояние АЗС без выезда на место. Фото подтверждают, что работы выполнены, а инвентарь в порядке.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Как приходит уведомление</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Каждый день в назначенное время Bitrix24 присылает push-уведомление на ваш телефон. У вас есть 30 минут, чтобы открыть уведомление и сдать отчёт.
              </p>
              <div class="my-4 flex justify-center">
                <MockupPushNotification />
              </div>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Как открыть задание</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                По нажатию на push-уведомление откроется страница отчёта со списком позиций. Каждой позиции — своё фото. Слева видно, какие позиции уже готовы, а какие требуют фото.
              </p>
              <div class="my-4 flex justify-center">
                <MockupAdminReport />
              </div>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Как снимать фото</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                На каждой позиции нажмите кнопку "Сделать фото". Откроется камера вашего телефона. Галерея не используется — фото должно быть свежим, снято именно сейчас. Сделанное фото автоматически отмечается зелёной галкой.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Что значат статусы</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                На странице отчёта и в дашборде используются три статуса:
              </p>
              <ul class="text-sm text-gray-700 leading-relaxed mt-2 space-y-1.5 ml-4">
                <li><strong>В работе</strong> — отчёт открыт, есть ещё время на сдачу.</li>
                <li><strong>Завершено</strong> — все обязательные фото загружены и отчёт принят.</li>
                <li><strong>Просрочено</strong> — время вышло, отчёт не был сдан полностью.</li>
              </ul>
            </section>
          </div>

          <!-- Reviewer tab -->
          <div v-if="activeTab === 'reviewer'" class="px-6 py-4 space-y-4">
            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Дашборд отчётов</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                На главной странице вы видите все отчёты сети АЗС за выбранный период. По умолчанию отображаются отчёты за сегодняшний день. Для каждого отчёта видна дата, номер АЗС, ФИО администратора, статус выполнения и количество загруженных фото.
              </p>
              <div class="my-4 flex justify-center">
                <MockupReviewerDashboard />
              </div>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Фильтры</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Используйте фильтры для поиска нужных отчётов: по дате, номеру АЗС и статусу. Фильтры можно комбинировать — например, посмотреть все просрочённые отчёты за конкретную дату по определённой АЗС.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Ручной запуск отчёта</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Кнопка "Создать отчёт" в правом верхнем углу позволяет вручную создать отчёт для проверки конкретной АЗС без учёта расписания. Это полезно для внеплановых проверок и неотложных ситуаций.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Просмотр фото</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                По клику на строку отчёта откроется подробный просмотр со всеми загруженными фото, временем и датой съёмки каждого фото, а также всеми метаданными отчёта.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Статусы</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Два основных статуса: <strong>Завершено</strong> — все обязательные позиции загружены и сдано вовремя; <strong>Просрочено</strong> — отчёт не сдан или сдан после истечения времени.
              </p>
            </section>
          </div>

          <!-- Settings tab -->
          <div v-if="activeTab === 'settings'" class="px-6 py-4 space-y-4">
            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Привязка смарт-процессов</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Перед первым использованием выберите два смарт-процесса: один для карточек АЗС, другой для отчётов. Затем сопоставьте их поля согласно образцу.
              </p>
              <div class="my-4 flex justify-center">
                <MockupSettings />
              </div>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Поле "Администратор АЗС"</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                В карточке АЗС обязательно должно быть поле типа "Сотрудник" (или "Контакт"), указывающее ответственного администратора. Push-уведомление придёт именно этому пользователю в назначенное время.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Обязательные фото</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Список обязательных позиций (например, "Колонки", "Касса", "Туалет") хранится в карточке каждой АЗС. Эта информация используется для проверки полноты отчёта перед отправкой.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Расписание и таймаут</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Задайте время рассылки отчётов (например, 09:00) и сдвиг ±X минут для рандомизации (чтобы не все администраторы получили уведомление одновременно). Таймаут N определяет, сколько минут отводится на сдачу отчёта после получения уведомления.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Роли</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Иерархия ролей: <strong>Администратор портала</strong> имеет доступ ко всем настройкам; <strong>Управляющий</strong> видит дашборд и отчёты всех АЗС; <strong>Администратор АЗС</strong> видит только свои отчёты. Роль определяется списками userId в настройках приложения.
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
