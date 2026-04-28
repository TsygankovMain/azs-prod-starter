# Sprint 0: Project Control Plane

## PM Summary

Goal:
- Make the project manageable before feature development starts.

Done:
- Repository origin points to the user's GitHub repository.
- Original `bitrix-tools/b24-ai-starter` repository is connected as upstream.
- Upstream push is disabled.
- Main project log was created.
- Sprint 0 log was created.
- Start time was recorded: 2026-04-28 16:54:07 MSK (+0300).

Not done yet:
- Bitrix24 task creation is blocked by expired direct MCP credentials.

Business result:
- We can safely commit and push project work to the user's repository.
- Time tracking task still needs MCP reauthorization before it can be created.

## Agent Notes

Execution rules:
- Use only direct Bitrix24 MCP/REST access for Bitrix24 operations.
- Use direct Bitrix24 MCP/REST only.
- Keep PM-readable and agent-readable logs in `docs/logs/`.
- Commit meaningful checkpoints frequently.

Git state:
- `origin`: `https://github.com/TsygankovMain/azs-prod-starter.git`
- `upstream` fetch: `https://github.com/bitrix-tools/b24-ai-starter.git`
- `upstream` push: `DISABLED`
- working branch: `master`

Bitrix24 task payload to create after MCP reauthorization:

```json
{
  "fields": {
    "TITLE": "АЗС прод: разработка приложения фото-отчётов",
    "DESCRIPTION": "Разработка Bitrix24-приложения для ежедневных фото-отчётов сети АЗС. Администратор АЗС получает push в мобильном Bitrix24, делает свежие фото по списку позиций, фото сохраняются на Диск Bitrix24 и привязываются к смарт-процессу Отчёт. Проверяющий видит статусы, просрочки и может запускать отчёт вручную. Старт работ: 2026-04-28 16:54:07 MSK.",
    "CREATED_BY": 1,
    "RESPONSIBLE_ID": 11,
    "GROUP_ID": 371,
    "ALLOW_TIME_TRACKING": "Y"
  }
}
```

Verification:
- `git remote -v` must show `origin` pointing to `TsygankovMain/azs-prod-starter`.
- `git remote -v` must show `upstream` push as `DISABLED`.
- `docs/logs/project-log.md` must contain current status and next step.
