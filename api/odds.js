export default async function handler(req, res) {
  const apiKey = process.env.ODDSPAPI_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "ODDSPAPI_KEY is not configured"
    });
  }

  const url =
    `https://api.oddspapi.io/v4/odds-by-tournaments` +
    `?bookmaker=stake` +
    `&tournamentIds=29242` +
    `&apiKey=${encodeURIComponent(apiKey)}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({
      error: "Failed to fetch odds"
    });
  }
}
