// SvelteKit Custom Database Client (transparent wrapper for PostgreSQL backend API)

class SvelteKitDatabaseQueryBuilder {
  private table: string;
  private action: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private data: any = null;
  private eqFilters: Record<string, any> = {};
  private inFilters: Record<string, any[]> = {};

  constructor(table: string) {
    this.table = table;
  }

  select(columns: string = '*') {
    return this;
  }

  eq(column: string, value: any) {
    this.eqFilters[column] = value;
    return this;
  }

  in(column: string, values: any[]) {
    this.inFilters[column] = values;
    return this;
  }

  insert(data: any | any[]) {
    this.action = 'insert';
    this.data = data;
    return this;
  }

  update(data: any) {
    this.action = 'update';
    this.data = data;
    return this;
  }

  delete() {
    this.action = 'delete';
    return this;
  }

  async then(onfulfilled?: (value: any) => any, onrejected?: (reason: any) => any) {
    try {
      const response = await fetch('/api/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          table: this.table,
          action: this.action,
          data: this.data,
          eqFilters: this.eqFilters,
          inFilters: this.inFilters
        })
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error?.message || 'Database query failed');
      }

      if (onfulfilled) {
        return Promise.resolve(result).then(onfulfilled);
      }
      return result;
    } catch (error) {
      if (onrejected) {
        return Promise.reject(error).catch(onrejected);
      }
      return { data: null, error };
    }
  }

  async single() {
    const res = await this.then();
    if (res.error) return res;
    const data = res.data;
    let item = null;
    if (Array.isArray(data)) {
      item = data.length > 0 ? data[0] : null;
    } else if (data) {
      item = data;
    }
    return { data: item, error: item ? null : new Error('Not found') };
  }

  async maybeSingle() {
    const res = await this.then();
    if (res.error) return res;
    const item = res.data && res.data.length > 0 ? res.data[0] : null;
    return { data: item, error: null };
  }
}

class SvelteKitRealtimeChannel {
  private channelName: string;
  private listeners: Array<{
    table: string;
    event: string;
    callback: (payload: any) => void;
  }> = [];
  private eventSource: EventSource | null = null;

  constructor(channelName: string) {
    this.channelName = channelName;
  }

  on(
    type: string,
    filter: { table: string; event?: string; filter?: string; schema?: string },
    callback: (payload: any) => void
  ) {
    const table = filter.table;
    const event = filter.event || '*';

    this.listeners.push({
      table,
      event,
      callback
    });
    return this;
  }

  subscribe() {
    if (typeof window === 'undefined') return this;

    const url = `/api/query/stream?channel=${encodeURIComponent(this.channelName)}`;
    this.eventSource = new EventSource(url);

    this.eventSource.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        const { table, eventType } = payload;

        this.listeners.forEach((lis) => {
          const tableMatch = lis.table === '*' || lis.table === table;
          const eventMatch = lis.event === '*' || lis.event === eventType;

          if (tableMatch && eventMatch) {
            lis.callback({
              schema: 'public',
              table,
              eventType,
              new: payload.new,
              old: payload.old
            });
          }
        });
      } catch (err) {
        console.error('Realtime SSE message parse error:', err);
      }
    };

    this.eventSource.onerror = (err) => {
      console.warn('Realtime SSE connection issue, retrying...', err);
    };

    return this;
  }

  unsubscribe() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
}

class SvelteKitDatabaseClient {
  from(table: string) {
    return new SvelteKitDatabaseQueryBuilder(table);
  }

  channel(channelName: string) {
    return new SvelteKitRealtimeChannel(channelName);
  }

  removeChannel(channel: SvelteKitRealtimeChannel) {
    channel.unsubscribe();
  }
}

export const db = new SvelteKitDatabaseClient();
