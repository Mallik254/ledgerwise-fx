export default async () => {
  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY?.trim());
  return new Response(
    JSON.stringify({
      ok: true,
      deployment: 'netlify-functions',
      geminiConfigured,
      models: {
        general: 'gemini-4-hydrogen',
        fast: 'gemini-3.1-flash-lite',
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
};
