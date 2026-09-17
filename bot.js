const { VK, Keyboard } = require('vk-io');
const axios = require('axios');

// ============ НАСТРОЙКИ ============
const VK_TOKEN = 'vk1.a.F13OKYyXAzwTaR5Y461mwAYl5U1A7XGVawd9xh8bCTKpMGeUKv8-DMCl5R7axeC4rYTbct8aOkWvZlqWjW6uI29lk1dCX2YJcjHzV3XEvIVhgnd06l7qAnxYkm3ZSU7kEkoxDUBcLsA3EtVouC6sYvbTfBr4BZ1nfbW2xCH1z-oROMavFhdDOWoleolsXF119VEshF0fZZ4DrKKzuV2MYQ';
const API_URL = 'https://ar-smh.ru/api/flights';

const vk = new VK({ token: VK_TOKEN });

// Хранилище состояний пользователей
const userStates = {};

// Хранилище подписок: { userId: { flightId: { status, flightNumber, ... } } }
const subscriptions = {};

// Хранилище последних известных статусов: { flightId: status }
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

// Формируем сообщение о рейсе
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

  return `✈️ Рейс: ${f.flightNumber}, ${f.airline}
📍 В: ${f.destination} (${f.iataCode || ''}), ${timeStr}
🕐 Ожидается в: ${fmtDt(departure)}
🏷️ Данные: Стойки: ${f.checkInCounters || '—'}, Выход: ${f.boardingGate ? 'G' + f.boardingGate : '—'}
${statusEmoji} Статус: ${(f.statusText || 'По расписанию').replace(/\n/g, ' ')}`;
}

// Формируем уведомление по типу статуса
function buildNotification(f, statusType) {
  const flight = f.flightNumber || '';
  const city = f.destination || '';
  const iata = f.iataCode || '';
  const counters = f.checkInCounters || '';
  const gate = f.boardingGate || '';

  switch (statusType) {
    case 'checkin':
      return `👋 Уважаемый пассажир!

Начинается регистрация на рейс ${flight} вылетающий в ${city} (${iata}). Стойки регистрации: ${counters}

📄 Не забудьте приготовить документ, удостоверяющий личность!`;

    case 'checkin_completed':
      return `👋 Уважаемый пассажир!

Регистрация на рейс ${flight}, вылетающий в ${city} (${iata}), закончена.

🚶 Посадка на рейс начнётся через несколько минут, выход G${gate}`;

    case 'boarding':
      return `👋 Уважаемый пассажир!

Начинается посадка на рейс ${flight} вылетающий в ${city} (${iata}).

🚪 Приглашаем вас пройти к выходу G${gate}. Приготовьте, пожалуйста, паспорт и посадочный талон. Желаем приятного полёта! ✈️`;

    case 'boarding_completed':
      return `👋 Уважаемый пассажир!

Закончилась посадка на рейс ${flight} вылетающий в ${city} (${iata}).

🕐 Вылет запланирован на ${fmtDt(f.expectedDeparture || f.scheduledDeparture)}`;

    case 'delayed':
      return `👋 Уважаемый пассажир!

⚠️ Вылет вашего рейса ${flight} в ${city} (${iata}) ${fmtDt(f.scheduledDeparture)} задерживается до ${fmtDt(f.expectedDeparture)}.

😔 Приносим извинения за доставленные неудобства!`;

    case 'cancelled':
      return `👋 Уважаемый пассажир!

❌ Вылет вашего рейса ${flight} в ${city} (${iata}) отменён.

📞 Обращайтесь в авиакомпанию за подробной информацией.`;

    default:
      return null;
  }
}

// Клавиатура с выбором даты
function getDateKeyboard() {
  return Keyboard.builder()
    .inline()
    .textButton({ label: '📅 Сегодня', payload: { cmd: 'date', value: 'today' }, color: Keyboard.PRIMARY_COLOR })
    .textButton({ label: '📅 Завтра', payload: { cmd: 'date', value: 'tomorrow' }, color: Keyboard.PRIMARY_COLOR });
}

// Клавиатура "Выбрать дату заново"
function getBackKeyboard() {
  return Keyboard.builder()
    .inline()
    .textButton({ label: '🔄 Выбрать другую дату', payload: { cmd: 'back' }, color: Keyboard.SECONDARY_COLOR });
}

// Клавиатура для подписки/отписки
function getSubscribeKeyboard(flightId, isSubscribed) {
  const kb = Keyboard.builder().inline();
  if (isSubscribed) {
    kb.textButton({ label: '🔕 Отписаться от рейса', payload: { cmd: 'unsub', flightId }, color: Keyboard.NEGATIVE_COLOR });
  } else {
    kb.textButton({ label: '🔔 Подписаться на рейс', payload: { cmd: 'sub', flightId }, color: Keyboard.POSITIVE_COLOR });
  }
  kb.textButton({ label: '🔄 Выбрать другую дату', payload: { cmd: 'back' }, color: Keyboard.SECONDARY_COLOR });
  return kb;
}

// Проверяем, подписан ли пользователь
function isUserSubscribed(userId, flightId) {
  return subscriptions[userId] && subscriptions[userId][flightId];
}

// Поиск рейсов
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

// Определяем тип изменения статуса
function getStatusChangeType(oldStatus, newStatus, f) {
  if (oldStatus === newStatus) return null;

  // Отмена — приоритетнее всего
  if (newStatus === 'cancelled') return 'cancelled';

  // Задержка
  if (newStatus === 'delayed') return 'delayed';

  // Стандартные статусы
  const map = {
    'checkin': 'checkin',
    'checkin_completed': 'checkin_completed',
    'boarding': 'boarding',
    'boarding_completed': 'boarding_completed'
  };
  return map[newStatus] || null;
}

// ============ ОТПРАВКА УВЕДОМЛЕНИЙ ============
async function checkSubscriptionsAndNotify() {
  try {
    const response = await axios.get(`${API_URL}?showDeparted=false`);
    const flights = response.data;

    // Карта рейсов по ID
    const flightMap = {};
    flights.forEach(f => { flightMap[f.id] = f; });

    for (const userId in subscriptions) {
      const userSubs = subscriptions[userId];
      for (const flightId in userSubs) {
        const flight = flightMap[flightId];
        if (!flight) continue;

        const currentStatus = flight.computedStatus;
        const oldStatus = lastStatuses[flightId];

        // Обновляем состояние
        if (oldStatus !== currentStatus) {
          lastStatuses[flightId] = currentStatus;

          // Формируем уведомление (только если не первая загрузка)
          if (oldStatus !== undefined) {
            const changeType = getStatusChangeType(oldStatus, currentStatus, flight);
            if (changeType) {
              const notification = buildNotification(flight, changeType);
              if (notification) {
                try {
                  await vk.api.messages.send({
                    peer_id: parseInt(userId),
                    message: notification,
                    random_id: Date.now() + Math.floor(Math.random() * 1000)
                  });
                  console.log(`✅ Уведомление отправлено ${userId} о рейсе ${flightId}: ${changeType}`);
                } catch (e) {
                  console.error(`❌ Ошибка отправки ${userId}:`, e.message);
                }
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('Ошибка проверки подписок:', e.message);
  }
}

// ============ ОБРАБОТКА СООБЩЕНИЙ ============
vk.updates.on('message_new', async (context) => {
  const userId = context.senderId;
  const text = (context.text || '').trim();
  const payload = context.messagePayload;

  // Обработка кнопок
  if (payload) {
    // Выбор даты
    if (payload.cmd === 'date') {
      userStates[userId] = { step: 'search', date: payload.value };
      await context.send({
        message: `🔎 Выбрана дата: ${payload.value === 'today' ? 'Сегодня' : 'Завтра'}\n\nВведите номер рейса, город или код ИАТА (например: SU-1234, Москва, SVO):`,
        keyboard: getBackKeyboard().toString()
      });
      return;
    }

    // Назад к выбору даты
    if (payload.cmd === 'back') {
      userStates[userId] = { step: 'date' };
      await context.send({
        message: '📅 Выберите дату:',
        keyboard: getDateKeyboard().toString()
      });
      return;
    }

    // Подписка
    if (payload.cmd === 'sub') {
      if (!subscriptions[userId]) subscriptions[userId] = {};
      subscriptions[userId][payload.flightId] = true;

      // Запоминаем текущий статус
      try {
        const r = await axios.get(`${API_URL}?showDeparted=false`);
        const f = r.data.find(x => x.id === payload.flightId);
        if (f) lastStatuses[payload.flightId] = f.computedStatus;
      } catch (e) {}

      await context.send({
        message: `🔔 Вы подписались на рейс.\n\nЯ буду присылать вам уведомления при:\n• начале регистрации\n• окончании регистрации\n• начале посадки\n• окончании посадки\n• задержке\n• отмене рейса`,
        keyboard: getSubscribeKeyboard(payload.flightId, true).toString()
      });
      return;
    }

    // Отписка
    if (payload.cmd === 'unsub') {
      if (subscriptions[userId] && subscriptions[userId][payload.flightId]) {
        delete subscriptions[userId][payload.flightId];
        if (Object.keys(subscriptions[userId]).length === 0) {
          delete subscriptions[userId];
        }
      }
      await context.send({
        message: `🔕 Вы отписались от уведомлений по этому рейсу.`,
        keyboard: getSubscribeKeyboard(payload.flightId, false).toString()
      });
      return;
    }
  }

  // Команды
  const lowerText = text.toLowerCase();
  if (lowerText === 'начать' || lowerText === 'start' || lowerText === '/start' || lowerText === 'привет' || lowerText === 'меню') {
    userStates[userId] = { step: 'date' };
    await context.send({
      message: `👋 Добро пожаловать в бота информации о статусе рейсов в аэропорту "Симашкино".\n\nПожалуйста, выберите в кнопке ниже дату, на которую вас интересует статус рейса.`,
      keyboard: getDateKeyboard().toString()
    });
    return;
  }

  // Проверяем состояние
  const state = userStates[userId];
  if (!state || state.step !== 'search') {
    userStates[userId] = { step: 'date' };
    await context.send({
      message: `👋 Добро пожаловать в бота информации о статусе рейсов в аэропорту "Симашкино".\n\nПожалуйста, выберите в кнопке ниже дату, на которую вас интересует статус рейса.`,
      keyboard: getDateKeyboard().toString()
    });
    return;
  }

  // Поиск рейса
  try {
    const response = await axios.get(`${API_URL}?showDeparted=false`);
    const flights = response.data;
    const found = findFlights(flights, text, state.date);

    if (found.length === 0) {
      await context.send({
        message: `😔 К сожалению, рейс «${text}» не найден.\n\nПопробуйте ввести другой номер рейса, город или код ИАТА:`,
        keyboard: getBackKeyboard().toString()
      });
      return;
    }

    // Отправляем информацию о найденных рейсах
    const first = found[0];
    const subscribed = isUserSubscribed(userId, first.id);

    let msg = `🔎 Найдено рейсов: ${found.length}\n\n`;
    msg += found.slice(0, 5).map(buildFlightMessage).join('\n\n➖➖➖➖➖\n\n');

    if (found.length > 5) {
      msg += `\n\n... и ещё ${found.length - 5} рейсов. Уточните запрос.`;
    }

    if (found.length === 1) {
      msg += `\n\n💡 Хотите получать уведомления об изменениях статуса этого рейса? Нажмите кнопку ниже.`;
      await context.send({
        message: msg,
        keyboard: getSubscribeKeyboard(first.id, subscribed).toString()
      });
    } else {
      await context.send({
        message: msg,
        keyboard: getBackKeyboard().toString()
      });
    }
  } catch (e) {
    console.error('Ошибка запроса:', e.message);
    await context.send({
      message: '⚠️ Произошла ошибка при получении данных. Попробуйте позже.',
      keyboard: getBackKeyboard().toString()
    });
  }
});

// ============ ЗАПУСК ============
console.log('🚀 Бот аэропорта Симашкино запускается...');

// Проверка подписок каждую минуту
setInterval(checkSubscriptionsAndNotify, 60000);

// Первый запуск проверки через 30 секунд (чтобы бот успел запуститься)
setTimeout(checkSubscriptionsAndNotify, 30000);

vk.updates.start().then(() => {
  console.log('✅ Бот успешно запущен!');
}).catch(err => {
  console.error('❌ Ошибка запуска:', err);
});
