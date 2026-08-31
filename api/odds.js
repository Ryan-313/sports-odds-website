export default async function handler(req, res) {
  const apiKey = process.env.ODDSPAPI_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "ODDSPAPI_KEY is not configured"
    });
  }

  // Today's date range in UTC.
  const now = new Date();
  const from = now.toISOString();

  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const to = tomorrow.toISOString();

  const url =
    `https://api.oddspapi.io/v4/fixtures` +
    `?sportId=10` +
    `&from=${encodeURIComponent(from)}` +
    `&to=${encodeURIComponent(to)}` +
    `&statusId=0` +
    `&hasOdds=true` +
    `&bookmakers=stake` +
    `&language=en` +
    `&apiKey=${encodeURIComponent(apiKey)}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data
      });
    }

    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({
      error: "Failed to fetch fixtures",
      details: error.message
    });
  }
}
