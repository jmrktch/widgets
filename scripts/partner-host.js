const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PARTNER_PORT || 8080;

app.use(express.static(path.join(__dirname, "..", "partner-test")));

app.listen(PORT, () => {
  console.log(`Partner host listening on http://localhost:${PORT}`);
});
