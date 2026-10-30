// React Native example — NOT RUN in this PoC (no React Native toolchain here); written against the same library API.
// Copy src/ceres-client.js into the app (or install the package later). React Native provides fetch and AbortController.
// baseUrl must be your backend's pass-through over HTTPS (never put the Ceres key in the app).
import React, { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Button, ScrollView, Text, TextInput, View } from "react-native";
import { createCeresClient, CeresError } from "./ceres-client";

export default function AskScreen() {
  const ceres = useMemo(() => createCeresClient({ baseUrl: "https://api.example.com/ceres" }), []);
  const [q, setQ] = useState(""); const [lang, setLang] = useState("ro");
  const [reply, setReply] = useState(null); const [error, setError] = useState(null); const [busy, setBusy] = useState(false);
  const inFlight = useRef(null);

  async function ask() {
    inFlight.current?.abort(); inFlight.current = new AbortController();
    setBusy(true); setReply(null); setError(null);
    try { setReply(await ceres.ask(q, { lang, signal: inFlight.current.signal })); }
    catch (e) { if (!(e instanceof CeresError && e.kind === "aborted")) setError(e); }
    finally { setBusy(false); }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <TextInput value={q} onChangeText={setQ} placeholder="Întreabă Ceres…" style={{ borderWidth: 1, borderRadius: 8, padding: 10 }} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button title={lang === "ro" ? "RO" : "EN"} onPress={() => setLang(lang === "ro" ? "en" : "ro")} />
        <Button title="Ask" onPress={ask} disabled={busy || !q.trim()} />
      </View>
      {busy && <ActivityIndicator />}
      {error && <Text>{error.kind}: {error.message}</Text>}
      {reply && (
        <View style={{ gap: 6 }}>
          <Text style={{ fontWeight: "700" }}>{reply.answered ? "ANSWER" : `${reply.decision} · ${reply.reasonCode}`}</Text>
          <Text>{reply.answer}</Text>
          {reply.citations.map((c) => <Text key={c.number + c.claim}>[{c.number}] “{c.quote}” — {c.passage?.sectionId}</Text>)}
        </View>
      )}
    </ScrollView>
  );
}
