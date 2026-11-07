const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== 'www.searchapi.io') return originalFetch(input, init);
  const query = url.searchParams.get('q') ?? '';
  if (query === 'fixture-failure') return Response.json({ error: 'fixture provider failure' }, { status: 503 });
  return Response.json({
    search_metadata: { status: 'Success' },
    organic_results: query === 'fixture-empty' ? [] : [{
      title: 'Booking documentation', link: process.env.SURF_SMOKE_SOURCE_URL || 'https://example.org/booking',
      snippet: 'Booking constraints apply to non-cancelled reservations.',
    }],
  });
};
