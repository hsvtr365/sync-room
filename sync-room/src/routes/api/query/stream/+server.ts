import type { RequestHandler } from './$types';
import { subscribe } from '$lib/server/broadcast';

export const GET: RequestHandler = ({ url }) => {
  const channel = url.searchParams.get('channel');
  if (!channel) {
    return new Response('Missing channel parameter', { status: 400 });
  }

  const stream = new ReadableStream({
    start(controller) {
      // Enqueue introductory comment to establish the connection
      controller.enqueue(': open\n\n');

      // Subscribe to broadcaster for this channel
      const unsubscribe = subscribe(channel, (data) => {
        try {
          controller.enqueue(`data: ${JSON.stringify(data)}\n\n`);
        } catch (e) {
          // Stream might be closed
        }
      });

      // Heartbeat to prevent connection timeout by proxy/browser (every 20s)
      const interval = setInterval(() => {
        try {
          controller.enqueue(': heartbeat\n\n');
        } catch (e) {
          // Stream might be closed
        }
      }, 20000);

      // SvelteKit calls return callback when stream terminates
      return () => {
        clearInterval(interval);
        unsubscribe();
      };
    },
    cancel() {
      // Cleanup if cancel event is triggered by the platform
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no' // Prevent buffering in Nginx or similar proxies
    }
  });
};
