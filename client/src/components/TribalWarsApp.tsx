"use client";

import { useState } from "react";
import { HUMAN, type MatchConfig } from "@/lib/matchConfig";
import { ArtDefs } from "./art";
import { Lobby } from "./Lobby";
import { MatchScreen } from "./MatchScreen";

const DEFAULT_CONFIG: MatchConfig = {
  boardSize: 10,
  playerCount: 2,
  piecesPerPlayer: 4,
  placementMode: "MANUAL",
  slots: {
    P1: HUMAN,
    P2: { type: "ai", modelId: "offline:heuristic", label: "Heuristic Shaman" },
    P3: HUMAN,
    P4: HUMAN,
  },
  aiDelayMs: 1200,
};

export function TribalWarsApp() {
  const [config, setConfig] = useState<MatchConfig>(DEFAULT_CONFIG);
  const [inMatch, setInMatch] = useState(false);
  const [matchId, setMatchId] = useState(0);

  return (
    <>
      <ArtDefs />
      {inMatch ? (
        <MatchScreen key={matchId} config={config} onLobby={() => setInMatch(false)} />
      ) : (
        <Lobby
          initial={config}
          onStart={(c) => {
            setConfig(c);
            setMatchId((id) => id + 1);
            setInMatch(true);
          }}
        />
      )}
    </>
  );
}
