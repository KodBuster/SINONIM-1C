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

## GitHub Actions (рабочий sync, пока Amvera режет AdvantShop)

Amvera Cron Job (Москва) **резолвит** `my.advantshop.net` → `85.92.118.90`, **качает FTP**, но **таймаутит** на TCP/443 к AdvantShop (~60с). IPv6 нет (`AAAA=-`). Это сетевой egress, не логин.

Пока Amvera не откроет outbound 443 к `85.92.118.90`:

1. Репозиторий → **Settings → Secrets and variables → Actions**
2. Добавить секреты из `.env.example` (те же имена: `ADVANTSHOP_*`, `FTP_*`)
3. **Actions → Sync stocks → Run workflow** (или ждать schedule `*/5 * * * *`)
4. В Amvera Cron Job можно **выключить расписание**, чтобы не жечь запуски впустую

Текст в поддержку Amvera:

> Cron Job (регион Москва). DNS `my.advantshop.net` → A=`85.92.118.90`, AAAA нет.
> FTP наружу работает. HTTPS к `https://my.advantshop.net/.../adminv2/login`
> (TCP 443 → 85.92.118.90) таймаутит ~60с из контейнера Cron Job.
> Нужен outbound TCP/443 к этому IP. Логи: `admin probe FAILED … timeout`.

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
