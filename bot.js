const { VK, Keyboard } = require('vk-io');
const axios = require('axios');

// ============ НАСТРОЙКИ ============
const VK_TOKEN = 'vk1.a.F13OKYyXAzwTaR5Y461mwAYl5U1A7XGVawd9xh8bCTKpMGeUKv8-DMCl5R7axeC4rYTbct8aOkWvZlqWjW6uI29lk1dCX2YJcjHzV3XEvIVhgnd06l7qAnxYkm3ZSU7kEkoxDUBcLsA3EtVouC6sYvbTfBr4BZ1nfbW2xCH1z-oROMavFhdDOWoleolsXF119VEshF0fZZ4DrKKzuV2MYQ';
const API_URL = 'https://ar-smh.ru/api/flights';

const vk = new VK({ token: VK_TOKEN });

// Хранилище состояний
const userStates = {};

// Хранилище подписок: { userId: { flightId: true } }
const subscriptions = {};

// Хранилище последних известных состояний рейсов: { flightId: { status, expected } }
const lastFlightStates = {};

// ============ ФУНКЦИИ ============
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
  if (delayed) timeStr = `${fmtTm(f.scheduledDeparture)} ➡️ ${fmtTm(f.expectedDeparture)}`;
  else timeStr = fmtTm(f.scheduledDeparture);
  const departure = f.expectedDeparture || f.scheduledDeparture;

  return `✈️ Рейс: ${f.flightNumber}, ${f.airline}
📍 В: ${f.destination} (${f.iataCode || ''}), ${timeStr}
🕐 Ожидается в: ${fmtDt(departure)}
🏷️ Данные: Стойки: ${f.checkInCounters || '—'}, Выход: ${f.boardingGate ? 'G' + f.boardingGate : '—'}
${statusEmoji} Статус: ${(f.statusText || 'По расписанию').replace(/\n/g, ' ')}`;
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

function getStatusChangeType(oldStatus, newStatus) {
  if (oldStatus === newStatus) return null;
  if (newStatus === 'cancelled') return 'cancelled';
  if (newStatus === 'delayed') return 'delayed';
  const map = {
    'checkin': 'checkin',
    'checkin_completed': 'checkin_completed',
    'boarding': 'boarding',
    'boarding_completed': 'boarding_completed'
  };
  return map[newStatus] || null;
}

// ============ КЛАВИАТУРЫ ============
function getDateKeyboard() {
  return Keyboard.builder().inline()
    .textButton({ label: '📅 Сегодня', payload: { cmd: 'date', value: 'today' }, color: Keyboard.PRIMARY_COLOR })
    .textButton({ label: '📅 Завтра', payload: { cmd: 'date', value: 'tomorrow' }, color: Keyboard.PRIMARY_COLOR });
}

function getBackKeyboard() {
  return Keyboard.builder().inline()
    .textButton({ label: '🔄 Выбрать другую дату', payload: { cmd: 'back' }, color: Keyboard.SECONDARY_COLOR });
}

function getSubscribeKeyboard(flightId, isSubscribed) {
  const kb = Keyboard.builder().inline();
  if (isSubscribed) kb.textButton({ label: '🔕 Отписаться от рейса', payload: { cmd: 'unsub', flightId }, color: Keyboard.NEGATIVE_COLOR });
  else kb.textButton({ label: '🔔 Подписаться на рейс', payload: { cmd: 'sub', flightId }, color: Keyboard.POSITIVE_COLOR });
  kb.textButton({ label: '🔄 Выбрать другую дату', payload: { cmd: 'back' }, color: Keyboard.SECONDARY_COLOR });
  return kb;
}

// ============ ОБРАБОТКА СООБЩЕНИЙ ============
vk.updates.on('message_new', async (context) => {
  const userId = context.senderId;
  const text = (context.text || '').trim();
  const payload = context.messagePayload;

  if (payload) {
    if (payload.cmd === 'date') {
      userStates[userId] = { step: 'search', date: payload.value };
      await context.send({ message: `🔎 Выбрана дата: ${payload.value === 'today' ? 'Сегодня' : 'Завтра'}\n\nВведите номер рейса, город или код ИАТА (например: SU-1234, Москва, SVO):`, keyboard: getBackKeyboard().toString() });
      return;
    }
    if (payload.cmd === 'back') {
      userStates[userId] = { step: 'date' };
      await context.send({ message: '📅 Выберите дату:', keyboard: getDateKeyboard().toString() });
      return;
    }
    if (payload.cmd === 'sub') {
      if (!subscriptions[userId]) subscriptions[userId] = {};
      subscriptions[userId][payload.flightId] = true;
      try {
        const r = await axios.get(`${API_URL}?showDeparted=false`);
        const f = r.data.find(x => x.id === payload.flightId);
        if (f) {
          lastFlightStates[payload.flightId] = {
            status: f.computedStatus,
            expected: f.expectedDeparture || null
          };
        }
      } catch (e) {}
      await context.send({ message: `🔔 Вы подписались на рейс.\n\nЯ буду присылать вам уведомления при:\n• начале регистрации\n• окончании регистрации\n• начале посадки\n• окончании посадки\n• задержке\n• отмене рейса`, keyboard: getSubscribeKeyboard(payload.flightId, true).toString() });
      return;
    }
    if (payload.cmd === 'unsub') {
      if (subscriptions[userId] && subscriptions[userId][payload.flightId]) {
        delete subscriptions[userId][payload.flightId];
        if (Object.keys(subscriptions[userId]).length === 0) delete subscriptions[userId];
      }
      await context.send({ message: `🔕 Вы отписались от уведомлений по этому рейсу.`, keyboard: getSubscribeKeyboard(payload.flightId, false).toString() });
      return;
    }
  }

  const lowerText = text.toLowerCase();
  if (['начать', 'start', '/start', 'привет', 'меню'].includes(lowerText)) {
    userStates[userId] = { step: 'date' };
    await context.send({ message: `👋 Добро пожаловать в бота информации о статусе рейсов в аэропорту "Симашкино".\n\nПожалуйста, выберите в кнопке ниже дату, на которую вас интересует статус рейса.`, keyboard: getDateKeyboard().toString() });
    return;
  }

  const state = userStates[userId];
  if (!state || state.step !== 'search') {
    userStates[userId] = { step: 'date' };
    await context.send({ message: `👋 Добро пожаловать! Пожалуйста, выберите дату:`, keyboard: getDateKeyboard().toString() });
    return;
  }

  try {
    const response = await axios.get(`${API_URL}?showDeparted=false`);
    const flights = response.data;
    const found = findFlights(flights, text, state.date);

    if (found.length === 0) {
      await context.send({ message: `😔 К сожалению, рейс «${text}» не найден.\n\nПопробуйте ввести другой номер рейса, город или код ИАТА:`, keyboard: getBackKeyboard().toString() });
      return;
    }

    const first = found[0];
    const subscribed = subscriptions[userId] && subscriptions[userId][first.id];

    let msg = `🔎 Найдено рейсов: ${found.length}\n\n`;
    msg += found.slice(0, 5).map(buildFlightMessage).join('\n\n➖➖➖➖➖\n\n');

    if (found.length > 5) {
      msg += `\n\n... и ещё ${found.length - 5} рейсов. Уточните запрос.`;
    }

    if (found.length === 1) {
      msg += `\n\n💡 Хотите получать уведомления об изменениях статуса этого рейса? Нажмите кнопку ниже.`;
      await context.send({ message: msg, keyboard: getSubscribeKeyboard(first.id, subscribed).toString() });
    } else {
      await context.send({ message: msg, keyboard: getBackKeyboard().toString() });
    }
  } catch (e) {
    console.error('Ошибка запроса:', e.message);
    await context.send({ message: '⚠️ Произошла ошибка при получении данных. Попробуйте позже.', keyboard: getBackKeyboard().toString() });
  }
});

// ============ ПРОВЕРКА ПОДПИСОК И УВЕДОМЛЕНИЯ ============
async function checkSubscriptionsAndNotify() {
  try {
    const response = await axios.get(`${API_URL}?showDeparted=false`);
    const flights = response.data;
    const flightMap = {};
    flights.forEach(f => { flightMap[f.id] = f; });

    for (const userId in subscriptions) {
      for (const flightId in subscriptions[userId]) {
        const flight = flightMap[flightId];
        if (!flight) continue;

        const currentStatus = flight.computedStatus;
        const currentExpected = flight.expectedDeparture || null;
        const old = lastFlightStates[flightId];

        if (!old) {
          lastFlightStates[flightId] = { status: currentStatus, expected: currentExpected };
          continue;
        }

        // ============ ПРОВЕРКА ЗАДЕРЖКИ ПО ВРЕМЕНИ ============
        const sched = new Date(flight.scheduledDeparture);
        const newExp = currentExpected ? new Date(currentExpected) : null;
        const oldExp = old.expected ? new Date(old.expected) : null;

        const wasDelayed = oldExp && oldExp > sched;
        const isDelayed = newExp && newExp > sched;

        if (!wasDelayed && isDelayed) {
          // Только что поставили задержку
          const notification = buildNotification(flight, 'delayed');
          if (notification) {
            try {
              await vk.api.messages.send({ peer_id: parseInt(userId), message: notification, random_id: Date.now() + Math.floor(Math.random() * 1000) });
              console.log(`✅ ВК уведомление о задержке ${userId} (${flightId})`);
            } catch (e) {
              console.error(`❌ Ошибка ${userId}:`, e.message);
            }
          }
        } else if (wasDelayed && isDelayed && newExp.getTime() !== oldExp.getTime()) {
          // Задержка уже была, но время изменилось
          const notification = buildNotification(flight, 'delayed');
          if (notification) {
            try {
              await vk.api.messages.send({ peer_id: parseInt(userId), message: notification, random_id: Date.now() + Math.floor(Math.random() * 1000) });
              console.log(`✅ ВК уведомление о новой задержке ${userId} (${flightId})`);
            } catch (e) {
              console.error(`❌ Ошибка ${userId}:`, e.message);
            }
          }
        } else if (wasDelayed && !isDelayed) {
          // Задержку убрали
          const text = `👋 Уважаемый пассажир!\n\n✈️ Хорошие новости! Ваш рейс ${flight.flightNumber} в ${flight.destination} (${flight.iataCode || ''}) снова вылетает по расписанию — ${fmtDt(flight.scheduledDeparture)}.`;
          try {
            await vk.api.messages.send({ peer_id: parseInt(userId), message: text, random_id: Date.now() + Math.floor(Math.random() * 1000) });
          } catch (e) {}
        }

        // ============ ПРОВЕРКА СМЕНЫ СТАТУСА ============
        if (old.status !== currentStatus) {
          const changeType = getStatusChangeType(old.status, currentStatus);
          if (changeType && changeType !== 'delayed') {
            const notification = buildNotification(flight, changeType);
            if (notification) {
              try {
                await vk.api.messages.send({ peer_id: parseInt(userId), message: notification, random_id: Date.now() + Math.floor(Math.random() * 1000) });
                console.log(`✅ ВК уведомление ${userId} (${changeType})`);
              } catch (e) {
                console.error(`❌ Ошибка ${userId}:`, e.message);
              }
            }
          }
        }

        lastFlightStates[flightId] = { status: currentStatus, expected: currentExpected };
      }
    }
  } catch (e) {
    console.error('ВК проверка подписок:', e.message);
  }
}

// ============ ЗАПУСК ============
console.log('🚀 ВК-бот аэропорта Симашкино запускается...');

setInterval(checkSubscriptionsAndNotify, 60000);
setTimeout(checkSubscriptionsAndNotify, 30000);

vk.updates.start().then(() => {
  console.log('✅ ВК-бот успешно запущен!');
}).catch(err => {
  console.error('❌ Ошибка запуска:', err);
});
