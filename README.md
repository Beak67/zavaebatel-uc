# ZAVAEBATEL UC — обновление магазина

## Важно
- Реальные заказы заблокированы, пока `SBP_ENABLED=false`.
- Этот код **не отправляет заказы в Nexus и не выдаёт UC автоматически**.
- Цена считается на сервере: `Nexus USD × NEXUS_USD_RUB × (1 + SALE_MARKUP)`.
- Курс 85 ₽/$ — выбранное тобой значение, не гарантированный рыночный курс.
- Не сохраняй секреты в GitHub. Вводи их только в Render Environment.
- Если старый Nexus-токен публиковался в переписке, отзови/замени его.

## Файлы
Заменить `server.js`, `package.json`; добавить `admin.html`. `.env.example` и `.gitignore` можно добавить/обновить.
Существующий `index.html` оставлен без изменений в этом архиве. Перед включением оплаты его интерфейс нужно отдельно связать с `/api/orders`, `/api/payment-info` и загрузкой чека.

## Настройка Render
1. Создай PostgreSQL в Render и скопируй **Internal Database URL**.
2. В Web Service → Environment добавь:
   - `DATABASE_URL` — внутренний URL базы
   - `ADMIN_PASSWORD` — уникальный длинный пароль
   - `SESSION_SECRET` — случайная строка минимум 32 символа
   - `NEXUS_SHOP_ID`, `NEXUS_SHOP_TOKEN` — действующие секреты
   - `NEXUS_PRICE_CURRENCY=USD`
   - `NEXUS_USD_RUB=85`
   - `SALE_MARKUP=0.20`
   - `SBP_ENABLED=false`
3. Deploy latest commit.
4. Проверь `https://ТВОЙ-ДОМЕН/api/health`, затем `/api/catalog`.
5. Админка: `https://ТВОЙ-ДОМЕН/admin`.

## Перед включением заказов
- Сначала свяжи существующий `index.html` с API создания заказа и загрузки чека.
- Заполни `SBP_PAYEE_NAME`, `SBP_BANK_NAME`, `SBP_PHONE`, `SBP_PAYMENT_INSTRUCTIONS`.
- Проверь оплату и возвраты, правила обработки персональных данных и требования местного законодательства.
- Только после этого и тестового заказа вручную установи `SBP_ENABLED=true`.
- Даже после включения заказов подтверждай платежи только по реальному поступлению в банковском приложении, а не по скриншоту.
