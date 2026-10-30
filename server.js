const express = require("express");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const fs = require("fs");

dotenv.config();

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

let sock;
let starting = false;

app.get("/", (req, res) => {
  res.send("WhatsApp AI Assistant is running!");
});

app.post("/ask", async (req, res) => {
  try {
    const question = req.body.question;

    if (!question) {
      return res.status(400).json({ error: "প্রশ্ন লিখুন" });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: question }],
    });

    res.json({
      answer: response.choices[0].message.content,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "উত্তর তৈরি করা যায়নি" });
  }
});

async function startWhatsApp() {
  if (starting) return;
  starting = true;

  try {
    const { state, saveCreds } =
      await useMultiFileAuthState("./auth_info");

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        console.log("WhatsApp connected!");
      }

      if (connection === "close") {
        starting = false;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(startWhatsApp, 5000);
        }
      }
    });

    if (!state.creds.registered) {
      const number = process.env.WHATSAPP_NUMBER;

      if (!number) {
        console.log("Set WHATSAPP_NUMBER in Render settings.");
        starting = false;
        return;
      }

      const code = await sock.requestPairingCode(number);
      console.log("WhatsApp Pairing Code:", code);
    }

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const message of messages) {
        if (!message.message || message.key.fromMe) continue;

        const jid = message.key.remoteJid;

        if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) {
          continue;
        }

        const text =
          message.message.conversation ||
          message.message.extendedTextMessage?.text;

        if (!text) continue;

        try {
          const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: "তুমি একজন বন্ধুসুলভ বাংলা AI সহকারী।",
              },
              {
                role: "user",
                content: text,
              },
            ],
          });

          const answer = response.choices[0].message.content;

          await sock.sendMessage(jid, { text: answer });
        } catch (error) {
          console.error("Reply error:", error);
        }
      }
    });

  } catch (error) {
    console.error("WhatsApp error:", error);
    starting = false;
  }
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startWhatsApp();
});
