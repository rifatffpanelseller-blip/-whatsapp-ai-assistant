
const express = require("express");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const QRCode = require("qrcode");

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
let qrImage = null;
let connectionStatus = "Connecting to WhatsApp...";

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return openai;
}

function extractText(message) {
  let content = message.message;

  if (!content) return null;

  // Handle ephemeral and view-once messages
  while (
    content.ephemeralMessage ||
    content.viewOnceMessage ||
    content.viewOnceMessageV2
  ) {
    content =
      content.ephemeralMessage?.message ||
      content.viewOnceMessage?.message ||
      content.viewOnceMessageV2?.message;
    if (!content) return null;
  }

  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    null
  );
}

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="bn">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>WhatsApp AI Assistant</title>
      <style>
        body {
          background: #101820;
          color: white;
          font-family: Arial, sans-serif;
          text-align: center;
          padding: 30px 15px;
        }
        .card {
          background: #1d2b36;
          padding: 25px;
          border-radius: 15px;
          max-width: 400px;
          margin: 30px auto;
        }
        img {
          width: 260px;
          max-width: 100%;
          background: white;
          padding: 10px;
          border-radius: 10px;
        }
        #status { color: #8ee6a8; }
      </style>
    </head>
    <body>
      <h2>WhatsApp AI Assistant</h2>
      <div class="card">
        <h3>WhatsApp QR Code</h3>
        <p id="status">${connectionStatus}</p>
        <img id="qr" src="/qr" alt="WhatsApp QR Code"
             onerror="this.style.display='none'">
        <p>WhatsApp খুলে Linked Devices থেকে QR Code স্ক্যান করুন।</p>
      </div>
      <script>
        async function updateStatus() {
          try {
            const response = await fetch("/status");
            const data = await response.json();
            document.getElementById("status").textContent = data.status;

            const qr = document.getElementById("qr");
            if (data.connected) {
              qr.style.display = "none";
            } else if (data.hasQR) {
              qr.style.display = "inline-block";
              qr.src = "/qr?t=" + Date.now();
            }
          } catch (e) {}
        }
        updateStatus();
        setInterval(updateStatus, 3000);
      </script>
    </body>
    </html>
  `);
});

app.get("/qr", (req, res) => {
  if (!qrImage) {
    return res.status(404).send("QR Code এখনো তৈরি হয়নি।");
  }

  res.type("png").send(
    Buffer.from(qrImage.split(",")[1], "base64")
  );
});

app.get("/status", (req, res) => {
  res.json({
    status: connectionStatus,
    connected: connectionStatus === "WhatsApp Connected!",
    hasQR: !!qrImage,
  });
});

app.post("/ask", async (req, res) => {
  try {
    const question = req.body.question;

    if (!question) {
      return res.status(400).json({ error: "প্রশ্ন লিখুন" });
    }

    const response = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "তুমি একজন বন্ধুসুলভ বাংলা AI সহকারী। সহজ ও সুন্দর বাংলায় উত্তর দেবে।",
        },
        { role: "user", content: question },
      ],
    });

    res.json({
      answer: response.choices[0].message.content,
    });
  } catch (error) {
    console.error("AI Error:", error.message);
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
      browser: Browsers.macOS("Desktop"),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !state.creds.registered) {
        try {
          qrImage = await QRCode.toDataURL(qr);
          connectionStatus = "QR Code তৈরি হয়েছে। স্ক্যান করুন।";
          console.log("WhatsApp QR Code generated.");
        } catch (error) {
          console.error("QR Error:", error.message);
        }
      }

      if (connection === "open") {
        qrImage = null;
        connectionStatus = "WhatsApp Connected!";
        console.log("WhatsApp connected successfully!");
      }

      if (connection === "close") {
        starting = false;
        sock = null;
        qrImage = null;
        connectionStatus = "Disconnected. Reconnecting...";

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        console.log("WhatsApp disconnected. Status:", statusCode);

        if (statusCode !== DisconnectReason.loggedOut) {
          if (reconnectTimer) clearTimeout(reconnectTimer);

          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            startWhatsApp();
          }, 5000);
        } else {
          connectionStatus = "Logged out. Please reconnect.";
          console.log("WhatsApp logged out. Scan a new QR code.");
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const message of messages) {
        if (!message.message || message.key.fromMe) continue;

        const jid = message.key.remoteJid;

        if (
          !jid ||
          jid === "status@broadcast" ||
          jid.endsWith("@g.us") ||
          jid.endsWith("@broadcast")
        ) {
          continue;
        }

        const userText = extractText(message);

        if (!userText || !userText.trim()) continue;

        console.log("Incoming private message received.");

        try {
          const response = await getOpenAI().chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: "তুমি একজন বন্ধুসুলভ বাংলা AI সহকারী। সহজ ও সুন্দর বাংলায় উত্তর দেবে।",
              },
              { role: "user", content: userText },
            ],
          });

          const answer = response.choices[0].message.content;

          if (!answer) {
            throw new Error("AI returned an empty response");
          }

          if (sock) {
            await sock.sendMessage(jid, { text: answer });
            console.log("AI reply sent successfully.");
          }
        } catch (error) {
          console.error("Reply Error:", error.message);
        }
      }
    });

  } catch (error) {
    console.error("WhatsApp Startup Error:", error.message);
    starting = false;
    sock = null;
    connectionStatus = "Connection error. Retrying...";

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
