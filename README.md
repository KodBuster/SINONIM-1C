# Sinonim 1C Cron

Отдельный сервис для Amvera **Cron Job**: раз в час забирает CSV с FTP (1С) и отправляет в AdvantShop `importproducts`.

Витрина [Sinonim](https://github.com/KodBuster/Sinonim) этот репозиторий не использует — она только читает каталог из AdvantShop.

## Схема

```text
1С → FTP (Терра) → этот Cron Job → AdvantShop → сайт synonym-jewelry.ru
```

## Локальный запуск

```bash
npm ci
cp .env.example .env.local   # заполнить секреты

npm run sync:dry -- --file samples/1c-stocks.sample.csv
npm run sync
```

## Рабочая схема (две сети)

| Кто | До FTP 1С | До AdvantShop admin |
|-----|-----------|---------------------|
| Amvera Cron | да | нет (таймаут :443) |
| GitHub Actions | нет (таймаут) | да |

Поэтому:

1. **Amvera** — только релей: FTP → commit `data/stocks-latest.csv` в GitHub  
   Env: `SYNC_UPLOAD_MODE=relay-github`, `FTP_*`, `SYNC_GITHUB_TOKEN` (PAT: Contents write + Actions write на этот репо)
2. **GitHub Actions** — `data/stocks-latest.csv` → AdvantShop admin  
   Secrets: `ADVANTSHOP_ADMIN_EMAIL`, `ADVANTSHOP_ADMIN_PASSWORD`, `ADVANTSHOP_ADMIN_URL`

PAT: GitHub → Settings → Developer settings → Fine-grained token → только `KodBuster/SINONIM-1C` → Contents: Read and write, Actions: Read and write.

Текст в поддержку Amvera (опционально, чтобы вернуть всё на Amvera):

> Cron Job Москва. DNS `my.advantshop.net` → `85.92.118.90`. FTP ок. HTTPS :443 таймаут ~60с. Нужен outbound TCP/443.

## Amvera

1. В ЛК Amvera: **Cron Jobs → Создайте первый Cron Job**
2. Подключить этот GitHub-репозиторий (или git push на remote Amvera)
3. Расписание (UTC Quartz): `0 */5 * * * ?` — каждые 5 минут  
   (время на сервере Amvera — UTC)
4. Политика при наложении: **REPLACE**
5. Max runtime: например **600** секунд
6. Env в секретах Amvera — см. `.env.example` (без кавычек)
7. `amvera.yaml` уже в корне: Docker-сборка, запуск `node sync.mjs`

После деплоя статус обычно: «Ожидает запуска» → по расписанию краткий run → снова ожидание.

## AdvantShop

- Включить «Включить интеграцию с 1С»
- Формат CSV
- **Выключить** «Автоматически удалять товары, которых нет в файле»
- URL: `.../api/1c/importproducts?apikey=...`
