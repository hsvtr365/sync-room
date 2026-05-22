import { EventEmitter } from 'events';

const emitter = new EventEmitter();
emitter.setMaxListeners(1000); // Allow many concurrent listeners

export function subscribe(channel: string, listener: (data: any) => void) {
  emitter.on(channel, listener);
  return () => {
    emitter.off(channel, listener);
  };
}

export function broadcast(table: string, eventType: 'INSERT' | 'UPDATE' | 'DELETE', payload: any, oldPayload: any = null) {
  let roomId = payload.room_id || payload.id;
  if (table === 'rooms') {
    roomId = payload.id;
  }

  if (!roomId) return;

  const channel = `room_realtime_${roomId}`;
  const message = {
    table,
    eventType,
    new: payload,
    old: oldPayload || { id: payload.id }
  };

  emitter.emit(channel, message);
}
