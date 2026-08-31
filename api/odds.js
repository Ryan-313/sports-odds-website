export default async function handler(req, res) {
  const apiKey = process.env.ODDSPAPI_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "ODDSPAPI_KEY is not configured"
    });
  }

  const sportId = Number(req.query.sportId || 10);
  const bookmaker = req.query.bookmaker || "stake";

  if (!Number.isInteger(sportId)) {
    return res.status(400).json({
      error: "Invalid sportId"
    });
  }

  const api = "https://api.oddspapi.io/v4";

  async function getJSON(url) {
    const response = await fetch(url);

    let data;

    try {
      data = await response.json();
    } catch {
      throw new Error(`OddsPAPI returned invalid JSON (${response.status})`);
    }

    if (!response.ok) {
      const message =
        data?.message ||
        data?.error ||
        `OddsPAPI request failed (${response.status})`;

      throw new Error(message);
    }

    return data;
  }

  try {
    /*
     * ---------------------------------------------------------
     * 1. Get tournaments for this sport
     * ---------------------------------------------------------
     */
    const tournamentsUrl =
      `${api}/tournaments` +
      `?sportId=${sportId}` +
      `&language=en` +
      `&apiKey=${encodeURIComponent(apiKey)}`;

    const tournaments = await getJSON(tournamentsUrl);

    if (!Array.isArray(tournaments)) {
      throw new Error("Invalid tournaments response from OddsPAPI");
    }

    /*
     * Only request tournaments that currently have fixtures.
     */
    const activeTournaments = tournaments.filter(t =>
      Number(t.futureFixtures || 0) > 0 ||
      Number(t.upcomingFixtures || 0) > 0 ||
      Number(t.liveFixtures || 0) > 0
    );

    /*
     * Keep the request manageable.
     */
    const selectedTournaments = activeTournaments.slice(0, 30);

    if (!selectedTournaments.length) {
      return res.status(200).json({
        sportId,
        bookmaker,
        tournaments: [],
        fixtures: []
      });
    }

    const tournamentIds = selectedTournaments
      .map(t => t.tournamentId)
      .filter(Boolean)
      .join(",");

    /*
     * ---------------------------------------------------------
     * 2. Get odds
     * ---------------------------------------------------------
     *
     * OddsPAPI documents this endpoint as:
     *
     * /v4/odds-by-tournaments
     *
     * with comma-separated tournament IDs.
     */
    const oddsUrl =
      `${api}/odds-by-tournaments` +
      `?tournamentIds=${encodeURIComponent(tournamentIds)}` +
      `&bookmaker=${encodeURIComponent(bookmaker)}` +
      `&language=en` +
      `&oddsFormat=decimal` +
      `&apiKey=${encodeURIComponent(apiKey)}`;

    const oddsResponse = await getJSON(oddsUrl);

    /*
     * OddsPAPI normally returns an array, but support
     * common wrapper formats as well.
     */
    const fixtures = Array.isArray(oddsResponse)
      ? oddsResponse
      : Array.isArray(oddsResponse?.data)
        ? oddsResponse.data
        : Array.isArray(oddsResponse?.fixtures)
          ? oddsResponse.fixtures
          : [];

    /*
     * ---------------------------------------------------------
     * 3. Get participant names
     * ---------------------------------------------------------
     */
    const participantsUrl =
      `${api}/participants` +
      `?sportId=${sportId}` +
      `&language=en` +
      `&apiKey=${encodeURIComponent(apiKey)}`;

    const participantsResponse = await getJSON(participantsUrl);

    const participants =
      participantsResponse &&
      typeof participantsResponse === "object"
        ? participantsResponse
        : {};

    /*
     * ---------------------------------------------------------
     * 4. Tournament name lookup
     * ---------------------------------------------------------
     */
    const tournamentMap = {};

    for (const tournament of tournaments) {
      tournamentMap[String(tournament.tournamentId)] =
        tournament.tournamentName || `Tournament ${tournament.tournamentId}`;
    }

    /*
     * ---------------------------------------------------------
     * 5. Normalize every fixture
     * ---------------------------------------------------------
     */
    const normalizedFixtures = fixtures.map(fixture => {

      const participant1Id = fixture.participant1Id;
      const participant2Id = fixture.participant2Id;

      const participant1Name =
        fixture.participant1Name ||
        participants[String(participant1Id)] ||
        `Team ${participant1Id}`;

      const participant2Name =
        fixture.participant2Name ||
        participants[String(participant2Id)] ||
        `Team ${participant2Id}`;

      const tournamentName =
        fixture.tournamentName ||
        tournamentMap[String(fixture.tournamentId)] ||
        `Tournament ${fixture.tournamentId}`;

      const stake =
        fixture.bookmakerOdds?.[bookmaker] ||
        fixture.bookmakerOdds?.stake ||
        null;

      const markets = stake?.markets || {};

      /*
       * Soccer Full Time Result:
       *
       * 101 = Home
       * 102 = Draw
       * 103 = Away
       */
      const fullTimeResult = markets["101"];

      const getPrice = outcomeId => {
        const player =
          fullTimeResult?.outcomes?.[String(outcomeId)]
            ?.players?.["0"];

        if (!player) {
          return null;
        }

        return {
          price:
            typeof player.price === "number"
              ? player.price
              : null,

          priceAmerican:
            player.priceAmerican ?? null,

          priceFractional:
            player.priceFractional ?? null,

          active:
            player.active !== false
        };
      };

      const odds = {
        home: getPrice(101),
        draw: getPrice(102),
        away: getPrice(103)
      };

      /*
       * Also expose every market so the frontend can
       * display other available betting markets later.
       */
      const marketSummary = Object.entries(markets).map(
        ([marketId, market]) => ({
          marketId,
          active: market?.marketActive === true,
          outcomes: market?.outcomes || {}
        })
      );

      return {
        fixtureId: fixture.fixtureId,

        participant1Id,
        participant2Id,

        participant1Name,
        participant2Name,

        sportId: fixture.sportId ?? sportId,

        tournamentId: fixture.tournamentId,
        tournamentName,

        seasonId: fixture.seasonId ?? null,
        statusId: fixture.statusId ?? null,

        startTime: fixture.startTime ?? null,

        hasOdds:
          fixture.hasOdds === true ||
          Boolean(stake),

        bookmaker,

        bookmakerActive:
          stake?.bookmakerIsActive === true,

        suspended:
          stake?.suspended === true,

        fixturePath:
          stake?.fixturePath || null,

        odds,

        marketSummary,

        rawMarkets: markets
      };
    });

    /*
     * Put fixtures with odds first.
     */
    normalizedFixtures.sort((a, b) => {
      const aHasOdds =
        a.odds.home ||
        a.odds.draw ||
        a.odds.away;

      const bHasOdds =
        b.odds.home ||
        b.odds.draw ||
        b.odds.away;

      if (aHasOdds && !bHasOdds) return -1;
      if (!aHasOdds && bHasOdds) return 1;

      return (
        new Date(a.startTime || 0) -
        new Date(b.startTime || 0)
      );
    });

    return res.status(200).json({
      sportId,
      bookmaker,

      tournaments: selectedTournaments.map(t => ({
        tournamentId: t.tournamentId,
        tournamentName: t.tournamentName,
        categoryName: t.categoryName,
        futureFixtures: t.futureFixtures,
        upcomingFixtures: t.upcomingFixtures,
        liveFixtures: t.liveFixtures
      })),

      fixtures: normalizedFixtures
    });

  } catch (error) {
    console.error("OddsPAPI error:", error);

    return res.status(500).json({
      error: error.message || "Failed to fetch odds"
    });
  }
}
