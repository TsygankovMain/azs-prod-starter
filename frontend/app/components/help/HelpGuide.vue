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
                Фото-отчёт подтверждает состояние АЗС: что работы выполнены, оборудование и помещения в порядке. Управляющий видит это по фотографиям, без выезда на место.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Как приходит запрос на отчёт</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Запрос приходит <strong>сообщением от бота приложения</strong> в чат Битрикс24 — это не «колокольчик» уведомлений. Так сделано специально: сообщение в мессенджере слышно всегда, в отличие от значка уведомлений, который легко пропустить.
              </p>
              <div class="my-4 flex justify-center">
                <MockupPushNotification />
              </div>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Как открыть задание</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Прямо в сообщении бота есть ссылка (кнопка) на форму отчёта. Нажмите её — откроется страница со списком обязательных позиций. У каждой позиции своё фото; слева видно, какие позиции уже готовы, а какие ещё требуют снимка.
              </p>
              <div class="my-4 flex justify-center">
                <MockupAdminReport />
              </div>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Как снимать фото</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Снимайте по списку обязательных ракурсов. На каждой позиции нажмите «Сделать фото» — откроется камера телефона; снимок делается живьём, именно сейчас. После съёмки фото загружается, и позиция отмечается зелёной галкой. Когда все обязательные фото готовы, отправьте отчёт.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Статусы и дедлайн</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                У задания есть дедлайн — отчёт нужно сдать до указанного времени. Статусы:
              </p>
              <ul class="text-sm text-gray-700 leading-relaxed mt-2 space-y-1.5 ml-4">
                <li><strong>В работе</strong> — задание открыто, время на сдачу ещё есть.</li>
                <li><strong>Сдан</strong> — все обязательные фото загружены и отчёт отправлен.</li>
                <li><strong>Просрочен</strong> — время вышло, отчёт не сдан полностью.</li>
              </ul>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Если просрочили</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Если дедлайн прошёл, бот пришлёт сообщение о просрочке. Причину можно указать кнопкой прямо в чате бота — нажмите её и выберите/впишите причину. Это поможет управляющему понять, что произошло.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Если сообщение не пришло</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Все запросы идут через бота. Если сообщение не приходит — проверьте, что бот приложения не отключён в чатах Битрикс24. Если бот выключен или удалён из чата, запросы и сообщения о просрочке доходить не будут.
              </p>
            </section>
          </div>

          <!-- Reviewer tab -->
          <div v-if="activeTab === 'reviewer'" class="px-6 py-4 space-y-4">
            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Дашборд</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Сводка за выбранный период: сколько АЗС сдали отчёт, лента событий, рейтинг и тренды по станциям. Сверху — главное за период; ниже — детали по каждой АЗС. Период переключается одной кнопкой (Сегодня, Вчера, Неделя или произвольная дата).
              </p>
              <div class="my-4 flex justify-center">
                <MockupReviewerDashboard />
              </div>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Лента событий, рейтинг и тренды</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Лента — хронология за период: рассылки, сдачи, просрочки, ручные запуски. Рейтинг и тренды показывают, какие АЗС сдают отчёты стабильно, а какие чаще опаздывают. Это помогает быстро увидеть проблемные станции.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Фотолента</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Просмотр всех присланных фото с фильтрами по АЗС, датам и категориям. Любое фото можно переслать в чат Битрикс24 с текстовым замечанием — например, отправить администратору АЗС снимок с указанием, что исправить.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Расписание рассылки</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Глобальные времена, когда автоматически запрашиваются отчёты, плюс разброс (джиттер) — чтобы запросы не уходили всем одновременно — и таймаут на сдачу. Меняете прямо здесь и сохраняете расписание, без перехода в Настройки.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">План отчётов</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Запланированные и отправленные слоты на <strong>выбранную дату</strong>. Здесь можно:
              </p>
              <ul class="text-sm text-gray-700 leading-relaxed mt-2 space-y-1.5 ml-4">
                <li><strong>Отменить отдельный слот</strong> — снять конкретный запрос.</li>
                <li><strong>Сформировать график</strong> — построить план слотов по расписанию.</li>
                <li><strong>Перевыпустить задания на сегодня</strong> — пересоздать сегодняшние запросы.</li>
                <li><strong>Запросить отчёт вне расписания</strong> — отправить задание выбранной АЗС прямо сейчас или на заданное время.</li>
              </ul>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Быстрый доступ</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Дашборд управляющего можно открыть из контекстного меню чата в мобильном Битрикс24 — не нужно искать приложение отдельно.
              </p>
            </section>
          </div>

          <!-- Settings tab -->
          <div v-if="activeTab === 'settings'" class="px-6 py-4 space-y-4">
            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Привязка смарт-процессов</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Перед первым использованием укажите, какой смарт-процесс отвечает за карточки АЗС, а какой — за отчёты. Затем сопоставьте их поля согласно образцу.
              </p>
              <div class="my-4 flex justify-center">
                <MockupSettings />
              </div>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Поле «Администратор АЗС»</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                В карточке АЗС укажите ответственного — поле «Администратор АЗС». Именно этому сотруднику бот отправит запрос на отчёт в назначенное время.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Обязательные фото</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Список ракурсов, которые требуется снять (например, «Колонки», «Касса», «Санузел»). По этому списку проверяется полнота отчёта перед отправкой.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Расписание, таймаут, джиттер</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Задайте время запроса отчётов (например, 09:00) и джиттер ±X минут — разброс, чтобы запросы не уходили всем администраторам одновременно. Таймаут определяет, сколько отводится на сдачу отчёта после получения запроса.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Роли и доступ</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Кто что видит:
              </p>
              <ul class="text-sm text-gray-700 leading-relaxed mt-2 space-y-1.5 ml-4">
                <li><strong>Администратор портала</strong> — полный доступ, включая эти настройки.</li>
                <li><strong>Управляющий</strong> — дашборд, расписание и фотолента.</li>
                <li><strong>Администратор АЗС</strong> — сдаёт отчёты по своим станциям.</li>
              </ul>
              <p class="text-sm text-gray-700 leading-relaxed mt-2">
                Роли определяются списками пользователей в настройках приложения.
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Бренды и внешний доступ</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Фото можно открыть партнёрам и брендам (например, ГПН) по внешней ссылке — без доступа к самому Битрикс24. Объедините АЗС в бренд и передайте ссылку партнёру на экране «Бренды».
              </p>
            </section>

            <section>
              <h4 class="font-semibold text-base mb-2 mt-6">Уведомления только через бота</h4>
              <p class="text-sm text-gray-700 leading-relaxed">
                Все уведомления идут <strong>только через бота</strong> приложения — в «колокольчик» ничего не приходит. Чтобы они работали, бот должен быть зарегистрирован, а режим доставки — выставлен на бота. Если бот не зарегистрирован или отключён, запросы и сообщения о просрочке доходить не будут.
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
