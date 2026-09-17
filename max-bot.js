const axios = require('axios');
const https = require('https');

// ============ НАСТРОЙКИ ============
const MAX_TOKEN = 'f9LHodD0cOIMKBEfixiw3yITxV1aIV8YY72fM-GfqEMOVkXSZR7fIjc5safl3dVst-J5vZOnd45ANfANEkGz';
const API_URL = 'https://ar-smh.ru/api/flights';

// MAX Bot API (новый домен)
const MAX_API = 'https://platform-api2.max.ru';

// Отключаем проверку SSL для сертификата Минцифры (если BotHost не поддерживает)
// ВАЖНО: если бот не подключается — оставь эту опцию. Если работает — лучше убрать.
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

const maxClient = axios.create({
  baseURL: MAX_API,
  headers: {
    'Authorization': MAX_TOKEN,
    'Content-Type': 'application/json'
  },
  httpsAgent
});

// Хранилище состояний
const userStates = {};
const subscriptions = {};
const lastStatuses = {};

// ============ ФУНКЦИИ ============
function getSamaraNow() {
  const now = new Date();
  const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utcMs + (4 * 3600000));
}

function fmtTm(s) {
  if (!s) return '—';
  const d = new Date(s);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtDt(s) {
  if (!s) return '—';
  const d = new Date(s);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function getStatusEmoji(status) {
  if (!status) return '⚪';
  const s = status.toLowerCase();
  if (s.includes('по расписанию')) return '🟢';
  if (s.includes('регистрация') && s.includes('закончена')) return '🟠';
  if (s.includes('регистрация')) return '🔵';
  if (s.includes('посадка') && s.includes('закончена')) return '🟣';
  if (s.includes('посадка')) return '🔴';
  if (s.includes('задержан')) return '🟡';
  if (s.includes('отменён')) return '❌';
  if (s.includes('вылетел')) return '✅';
  if (s.includes('приостановлено')) return '⏸️';
  if (s.includes('питание')) return '🍽️';
  return '⚪';
}

function buildFlightMessage(f) {
  const delayed = f.expectedDeparture && new Date(f.expectedDeparture) > new Date(f.scheduledDeparture);
  const statusEmoji = getStatusEmoji(f.statusText);

  let timeStr;
  if (delayed) {
    timeStr = `${fmtTm(f.scheduledDeparture)} ➡️ ${fmtTm(f.expectedDeparture)}`;
  } else {
    timeStr = fmtTm(f.scheduledDeparture);
  }

  const departure = f.expectedDeparture || f.scheduledDeparture;

  return `✈️ Рейс: ${f.flightNumber}, ${f.airline}\n📍 В: ${f.destination} (${f.iataCode || ''}), ${timeStr}\n🕐 Ожидается в: ${fmtDt(departure)}\n🏷️ Данные: Стойки: ${f.checkInCounters || '—'}, Выход: ${f.boardingGate ? 'G' + f.boardingGate : '—'}\n${statusEmoji} Статус: ${(f.statusText || 'По расписанию').replace(/\n/g, ' ')}`;
}

function buildNotification(f, statusType) {
  const flight = f.flightNumber || '';
  const city = f.destination || '';
  const iata = f.iataCode || '';
  const counters = f.checkInCounters || '';
  const gate = f.boardingGate || '';

  switch (statusType) {
    case 'checkin':
      return `👋 Уважаемый пассажир!\n\nНачинается регистрация на рейс ${flight} вылетающий в ${city} (${iata}). Стойки регистрации: ${counters}\n\n📄 Не забудьте приготовить документ, удостоверяющий личность!`;
    case 'checkin_completed':
      return `👋 Уважаемый пассажир!\n\nРегистрация на рейс ${flight}, вылетающий в ${city} (${iata}), закончена.\n\n🚶 Посадка на рейс начнётся через несколько минут, выход G${gate}`;
    case 'boarding':
      return `👋 Уважаемый пассажир!\n\nНачинается посадка на рейс ${flight} вылетающий в ${city} (${iata}).\n\n🚪 Приглашаем вас пройти к выходу G${gate}. Приготовьте, пожалуйста, паспорт и посадочный талон. Желаем приятного полёта! ✈️`;
    case 'boarding_completed':
      return `👋 Уважаемый пассажир!\n\nЗакончилась посадка на рейс ${flight} вылетающий в ${city} (${iata}).\n\n🕐 Вылет запланирован на ${fmtDt(f.expectedDeparture || f.scheduledDeparture)}`;
    case 'delayed':
      return `👋 Уважаемый пассажир!\n\n⚠️ Вылет вашего рейса ${flight} в ${city} (${iata}) ${fmtDt(f.scheduledDeparture)} задерживается до ${fmtDt(f.expectedDeparture)}.\n\n😔 Приносим извинения за доставленные неудобства!`;
    case 'cancelled':
      return `👋 Уважаемый пассажир!\n\n❌ Вылет вашего рейса ${flight} в ${city} (${iata}) отменён.\n\n📞 Обращайтесь в авиакомпанию за подробной информацией.`;
    default:
      return null;
  }
}

// Клавиатура MAX (формат attachments)
function getDateKeyboard() {
  return {
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [
          { type: 'callback', text: '📅 Сегодня', payload: JSON.stringify({ cmd: 'date', value: 'today' }) },
          { type: 'callback', text: '📅 Завтра', payload: JSON.stringify({ cmd: 'date', value: 'tomorrow' }) }
        ]
      ]
    }
  };
}

function getBackKeyboard() {
  return {
    type: 'inline_keyboard',
    payload: {
      buttons: [
        [{ type: 'callback', text: '🔄 Выбрать другую дату', payload: JSON.stringify({ cmd: 'back' }) }]
      ]
    }
  };
}

function getSubscribeKeyboard(flightId, isSubscribed) {
  const buttons = [];
  if (isSubscribed) {
    buttons.push([{ type: 'callback', text: '🔕 Отписаться от рейса', payload: JSON.stringify({ cmd: 'unsub', flightId }) }]);
  } else {
    buttons.push([{ type: 'callback', text: '🔔 Подписаться на рейс', payload: JSON.stringify({ cmd: 'sub', flightId }) }]);
  }
  buttons.push([{ type: 'callback', text: '🔄 Выбрать другую дату', payload: JSON.stringify({ cmd: 'back' }) }]);
  return { type: 'inline_keyboard', payload: { buttons } };
}

function isUserSubscribed(userId, flightId) {
  return subscriptions[userId] && subscriptions[userId][flightId];
}

function findFlights(flights, query, date) {
  const q = query.trim().toLowerCase();
  return flights.filter(f => {
    if (date && f.flightDay !== date) return false;
    const number = (f.flightNumber || '').toLowerCase();
    const dest = (f.destination || '').toLowerCase();
    const iata = (f.iataCode || '').toLowerCase();
    return number.includes(q) || dest.includes(q) || iata === q;
  });
}

function getStatusChangeType(oldStatus, newStatus, f) {
  if (oldStatus === newStatus) return null;
  if (newStatus === 'cancelled') return 'cancelled';
  if (newStatus === 'delayed') return 'delayed';
  const map = { 'checkin': 'checkin', 'checkin_completed': 'checkin_completed', 'boarding': 'boarding', 'boarding_completed': 'boarding_completed' };
  return map[newStatus] || null;
}

// ============ ОТПРАВКА СООБЩЕНИЙ В MAX ============
async function sendMessage(chatId, text, keyboard = null) {
  try {
    const body = {
      text: text,
      notify: true
    };
    if (keyboard) {
      body.attachments = [keyboard];
    }
    const r = await maxClient.post('/messages', {
      ...body,
      chat_id: chatId
    });
    console.log('✅ Сообщение отправлено', chatId);
    return r.data;
  } catch (e) {
    console.error('❌ Ошибка отправки MAX:', e.response?.data || e.message);
    throw e;
  }
}

// ============ ПРОВЕРКА ПОДПИСОК ============
async function checkSubscriptionsAndNotify() {
  try {
    const response = await axios.get(`${API_URL}?showDeparted=false`);
    const flights = response.data;
    const flightMap = {};
    flights.forEach(f => { flightMap[f.id] = f; });

    for (const userId in subscriptions) {
      const userSubs = subscriptions[userId];
      for (const flightId in userSubs) {
        const flight = flightMap[flightId];
        if (!flight) continue;
        const currentStatus = flight.computedStatus;
        const oldStatus = lastStatuses[flightId];

        if (oldStatus !== currentStatus) {
          lastStatuses[flightId] = currentStatus;
          if (oldStatus !== undefined) {
            const changeType = getStatusChangeType(oldStatus, currentStatus, flight);
            if (changeType) {
              const notification = buildNotification(flight, changeType);
              if (notification) {
                try {
                  await sendMessage(parseInt(userId), notification);
                  console.log(`✅ Уведомление MAX отправлено ${userId} о рейсе ${flightId}: ${changeType}`);
                } catch (e) {
                  console.error(`❌ Ошибка отправки MAX ${userId}:`, e.message);
                }
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('Ошибка проверки подписок MAX:', e.message);
  }
}

// ============ ПОЛУЧЕНИЕ СООБЩЕНИЙ (Long Polling) ============
async function startPolling() {
  console.log('🚀 Запуск Long Polling MAX...');
  let marker = null;

  const poll = async () => {
    try {
      const params = { timeout: 30, limit: 100 };
      if (marker) params.marker = marker;

      const r = await maxClient.get('/updates', { params });
      const data = r.data;

      if (data.marker) marker = data.marker;

      if (data.updates && data.updates.length > 0) {
        for (const update of data.updates) {
          await handleUpdate(update);
        }
      }
    } catch (e) {
      console.error('Ошибка Long Polling MAX:', e.response?.data || e.message);
      await new Promise(res => setTimeout(res, 3000));
    }
    // Рекурсивно продолжаем
    setTimeout(poll, 100);
  };

  poll();
}

// ============ ОБРАБОТКА ОБНОВЛЕНИЙ ============
async function handleUpdate(update) {
  // Нажатие кнопки "Начать"
  if (update.update_type === 'bot_started') {
    const chatId = update.chat_id || update.user_id;
    userStates[chatId] = { step: 'date' };
    await sendMessage(chatId, `👋 Добро пожаловать в бота информации о статусе рейсов в аэропорту "Симашкино".\n\nПожалуйста, выберите в кнопке ниже дату, на которую вас интересует статус рейса.`, getDateKeyboard());
    return;
  }

  // Обычное сообщение
  if (update.update_type === 'message_created') {
    const msg = update.message;
    if (!msg || !msg.body) return;
    const chatId = msg.chat_id || update.chat_id;
    const userId = msg.sender?.user_id || chatId;
    const text = (msg.body.text || '').trim();

    // Нажатие callback-кнопки
    if (msg.body.attachments) {
      for (const att of msg.body.attachments) {
        if (att.type === 'inline_keyboard') {
          // Это нажатие кнопки — payload в другом месте
        }
      }
    }

    // Проверяем payload (если это callback)
    const payloadRaw = msg.payload || msg.body.payload;
    if (payloadRaw) {
      let payload;
      try { payload = typeof payloadRaw === 'string' ? JSON.parse(payloadRaw) : payloadRaw; } catch (e) { return; }

      if (payload.cmd === 'date') {
        userStates[userId] = { step: 'search', date: payload.value };
        await sendMessage(chatId, `🔎 Выбрана дата: ${payload.value === 'today' ? 'Сегодня' : 'Завтра'}\n\nВведите номер рейса, город или код ИАТА (например: SU-1234, Москва, SVO):`, getBackKeyboard());
        return;
      }
      if (payload.cmd === 'back') {
        userStates[userId] = { step: 'date' };
        await sendMessage(chatId, '📅 Выберите дату:', getDateKeyboard());
        return;
      }
      if (payload.cmd === 'sub') {
        if (!subscriptions[userId]) subscriptions[userId] = {};
        subscriptions[userId][payload.flightId] = true;
        try {
          const r = await axios.get(`${API_URL}?showDeparted=false`);
          const f = r.data.find(x => x.id === payload.flightId);
          if (f) lastStatuses[payload.flightId] = f.computedStatus;
        } catch (e) {}
        await sendMessage(chatId, `🔔 Вы подписались на рейс.\n\nЯ буду присылать вам уведомления при:\n• начале регистрации\n• окончании регистрации\n• начале посадки\n• окончании посадки\n• задержке\n• отмене рейса`, getSubscribeKeyboard(payload.flightId, true));
        return;
      }
      if (payload.cmd === 'unsub') {
        if (subscriptions[userId] && subscriptions[userId][payload.flightId]) {
          delete subscriptions[userId][payload.flightId];
          if (Object.keys(subscriptions[userId]).length === 0) delete subscriptions[userId];
        }
        await sendMessage(chatId, '🔕 Вы отписались от уведомлений по этому рейсу.', getSubscribeKeyboard(payload.flightId, false));
        return;
      }
    }

    // Обычный текст
    const lowerText = text.toLowerCase();
    if (lowerText === 'начать' || lowerText === 'start' || lowerText === '/start' || lowerText === 'привет' || lowerText === 'меню') {
      userStates[userId] = { step: 'date' };
      await sendMessage(chatId, `👋 Добро пожаловать в бота информации о статусе рейсов в аэропорту "Симашкино".\n\nПожалуйста, выберите в кнопке ниже дату, на которую вас интересует статус рейса.`, getDateKeyboard());
      return;
    }

    const state = userStates[userId];
    if (!state || state.step !== 'search') {
      userStates[userId] = { step: 'date' };
      await sendMessage(chatId, `👋 Добро пожаловать в бота информации о статусе рейсов в аэропорту "Симашкино".\n\nПожалуйста, выберите в кнопке ниже дату, на которую вас интересует статус рейса.`, getDateKeyboard());
      return;
    }

    // Поиск рейса
    try {
      const response = await axios.get(`${API_URL}?showDeparted=false`);
      const flights = response.data;
      const found = findFlights(flights, text, state.date);

      if (found.length === 0) {
        await sendMessage(chatId, `😔 К сожалению, рейс «${text}» не найден.\n\nПопробуйте ввести другой номер рейса, город или код ИАТА:`, getBackKeyboard());
        return;
      }

      const first = found[0];
      const subscribed = isUserSubscribed(userId, first.id);

      let msg = `🔎 Найдено рейсов: ${found.length}\n\n`;
      msg += found.slice(0, 5).map(buildFlightMessage).join('\n\n➖➖➖➖➖\n\n');
      if (found.length > 5) msg += `\n\n... и ещё ${found.length - 5} рейсов. Уточните запрос.`;

      if (found.length === 1) {
        msg += `\n\n💡 Хотите получать уведомления об изменениях статуса этого рейса? Нажмите кнопку ниже.`;
        await sendMessage(chatId, msg, getSubscribeKeyboard(first.id, subscribed));
      } else {
        await sendMessage(chatId, msg, getBackKeyboard());
      }
    } catch (e) {
      console.error('Ошибка запроса MAX:', e.message);
      await sendMessage(chatId, '⚠️ Произошла ошибка при получении данных. Попробуйте позже.', getBackKeyboard());
    }
  }
}

// ============ ЗАПУСК ============
console.log('🚀 MAX-бот аэропорта Симашкино запускается...');

// Проверка подписок каждую минуту
setInterval(checkSubscriptionsAndNotify, 60000);
setTimeout(checkSubscriptionsAndNotify, 30000);

// Запуск Long Polling
startPolling();
