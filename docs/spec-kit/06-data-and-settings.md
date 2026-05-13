# 06. Данные И Настройки

## Settings

Актуальная структура настроек:

```json
{
  "azs": {
    "entityTypeId": 0,
    "fields": {
      "admin": "",
      "reviewers": "",
      "photoSet": "",
      "enabled": ""
    }
  },
  "photoType": {
    "entityTypeId": 0,
    "fields": {
      "code": "",
      "title": "",
      "sort": "",
      "active": ""
    }
  },
  "report": {
    "entityTypeId": 0,
    "fields": {
      "azs": "",
      "trigger": "",
      "folderId": "",
      "photos": ""
    },
    "stages": {
      "new": "",
      "inProgress": "",
      "done": "",
      "expired": ""
    },
    "timeoutMinutes": 60,
    "dispatchJitterMinutes": 15,
    "dispatchTimes": []
  },
  "disk": {
    "rootFolderId": 0,
    "folderNameTemplate": "{yyyy-mm}/{dd}/{azs}"
  },
  "timezone": "Europe/Moscow",
  "access": {
    "adminUserIds": [],
    "reviewerUserIds": [],
    "azsAdminUserIds": []
  }
}
```

## Маппинг Полей

- `azs.fields.admin`: пользователь, ответственный за сдачу отчёта.
- `azs.fields.reviewers`: пользователи, получающие уведомления о результате.
- `azs.fields.photoSet`: множественная привязка к `Типы фото`.
- `azs.fields.enabled`: флаг участия в расписании.
- `photoType.fields.code`: технический код фото.
- `photoType.fields.title`: название для интерфейса.
- `photoType.fields.sort`: порядок съёмки.
- `photoType.fields.active`: флаг активности.
- `report.fields.folderId`: строковый ID папки Диска, обязательный для production.

## Служебные Данные

`dispatch_log`:
- фиксирует созданные слоты;
- защищает от дублей автоматического запуска;
- различает auto/manual lifecycle.

`report_photo`:
- хранит состояние каждого обязательного фото;
- связывает `photoCode`, Disk file id, folder id и статус загрузки;
- позволяет продолжить отчёт при частично выполненной сдаче.

## Папки И Файлы

Шаблон папки по умолчанию:

```text
{yyyy-mm}/{dd}/{azs}
```

Пример:

```text
2026-05/05/АЗС 77
```

Имя файла строится из:

```text
{slotHHmm}_{photoCode}_{isoTimestamp}.{ext}
```

Технический код фото должен быть стабильным: латиница, цифры и `_`.

## Роли

Роли хранятся в `settings.access`. Если пользователь есть в нескольких списках, применяется приоритет:

```text
Администратор > Проверяющий > Администратор АЗС
```
