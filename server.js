const express = require("express");
const dotenv = require("dotenv");
const OpenAI = require("openai");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} = require("@whiskeysockets/baileys");

dotenv.config();

const app = express();
app.use(express.json());

let sock;
let starting = false;
let reconnectTimer = null;
let openai;

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing in Render Environment");
  }

  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return openai;
}

app.get("/", (req, res) => {
  res.send("WhatsApp AI Assistant is running!");
});

app.post("/ask", async (req, res) => {
  try {
    const question = req.body.question;

    if (!question) {
      return res.status(400).json({
        error: "প্রশ্ন লিখুন",
      });
    }

    const client = getOpenAI();

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: question,
        },
      ],
    });

    res.json({
      answer: response.choices[0].message.content,
    });
  } catch (error) {
    console.error("AI Error:", error.message);

    res.status(500).json({
      error: "উত্তর তৈরি করা যায়নি",
    });
  }
});

async function startWhatsApp() {
  if (starting) return;

  starting = true;

  let pairingRequested = false;

  try {
    const { state, saveCreds } =
      await useMultiFileAuthState("./auth_info");

    sock = makeWASocket({
      auth: state,
      browser: Browsers.macOS("Desktop"),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
    });

    sock.ev.on("creds.update", saveCreds);

    // WhatsApp connection events
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Pairing code তৈরি করার সঠিক সময়
      if (
        qr &&
        !state.creds.registered &&
        !pairingRequested
      ) {
        pairingRequested = true;

        try {
          const number = (
            process.env.WHATSAPP_NUMBER || ""
          ).replace(/\D/g, "");

          if (!number) {
            console.log("WHATSAPP_NUMBER is missing.");
            return;
          }

          const code = await sock.requestPairingCode(number);

          console.log("WhatsApp Pairing Code:", code);
          console.log(
            "WhatsApp খুলে Linked Devices থেকে কোডটি ব্যবহার করুন।"
          );
        } catch (error) {
          pairingRequested = false;
          console.error(
            "Pairing Code Error:",
            error.message
          );
        }
      }

      if (connection === "open") {
        console.log("WhatsApp connected successfully!");
      }

      if (connection === "close") {
        starting = false;
        sock = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        console.log(
          "WhatsApp disconnected. Status:",
          statusCode
        );

        if (statusCode !== DisconnectReason.loggedOut) {
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
          }

          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            startWhatsApp();
          }, 5000);
        } else {
          console.log(
            "WhatsApp logged out. Please reconnect."
          );
        }
      }
    });

    // Incoming messages
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const message of messages) {
        if (!message.message || message.key.fromMe) {
          continue;
        }

        const jid = message.key.remoteJid;

        if (
          !jid ||
          jid === "status@broadcast" ||
          jid.endsWith("@g.us")
        ) {
          continue;
        }

        const text =
          message.message.conversation ||
          message.message.extendedTextMessage?.text;

        if (!text) continue;

        try {
          const client = getOpenAI();

          const response =
            await client.chat.completions.create({
              model: "gpt-4o-mini",
              messages: [
                {
                  role: "system",
                  content:
                    "তুমি একজন বন্ধুসুলভ বাংলা AI সহকারী। সহজ ও সুন্দর বাংলায় উত্তর দেবে।",
                },
                {
                  role: "user",
                  content: text,
                },
              ],
            });

          const answer =
            response.choices[0].message.content;

          await sock.sendMessage(jid, {
            text: answer,
          });
        } catch (error) {
          console.error(
            "Reply Error:",
            error.message
          );
        }
      }
    });
  } catch (error) {
    console.error("WhatsApp Startup Error:", error);

    starting = false;
    sock = null;

    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startWhatsApp();
      }, 10000);
    }
  }
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startWhatsApp();
});
