try {
  const token = process.env.SIFRIC_PLATFORM_TOKEN;
  if (!token) throw new Error('Missing backend credential.');
  const port = Number(process.env.PORT ?? 8788);
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok || (await response.json()).status !== 'ok') process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
