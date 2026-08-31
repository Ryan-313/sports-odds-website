export default async function handler(req, res) {
  const apiKey = process.env.ODDSPAPI_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "ODDSPAPI_KEY is not configured"
    });
  }

  try {
    const url =
      "https://api.oddspapi.io/v4/sports" +
      "?language=en" +
      "&apiKey=" +
      encodeURIComponent(apiKey);

    const response =
      await fetch(url);

    const text =
      await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = {
        message:
          text ||
          "Invalid response from OddsPAPI"
      };
    }

    if (!response.ok) {
      return res
        .status(response.status)
        .json({
          error:
            data?.message ||
            data?.error ||
            "OddsPAPI request failed",

          details:
            data?.details || null,

          code:
            data?.code || null
        });
    }

    return res.status(200).json(
      Array.isArray(data)
        ? data
        : []
    );
  } catch (error) {
    console.error(
      "Sports API error:",
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        "Failed to fetch sports"
    });
  }
}
