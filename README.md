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

## Amvera

1. В ЛК Amvera: **Cron Jobs → Создайте первый Cron Job**
2. Подключить этот GitHub-репозиторий (или git push на remote Amvera)
3. Расписание (UTC): `0 0 * * * ?` — каждый час в :00  
   (Москва = UTC+3, то есть 12:00 UTC = 15:00 МСК)
4. Политика при наложении: **REPLACE**
5. Max runtime: например **600** секунд
6. Env в секретах Amvera — см. `.env.example` (без кавычек)
7. `amvera.yaml` уже в корне: сборка `npm ci`, запуск `node sync.mjs`

После деплоя статус обычно: «Ожидает запуска» → по расписанию краткий run → снова ожидание.

## AdvantShop

- Включить «Включить интеграцию с 1С»
- Формат CSV
- **Выключить** «Автоматически удалять товары, которых нет в файле»
- URL: `.../api/1c/importproducts?apikey=...`
