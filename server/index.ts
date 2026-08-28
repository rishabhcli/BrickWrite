import express from "express";
import generationRouter from "./generation/api";

const app = express();
// JSON body parsing middleware
app.use(express.json());

// Mount generation router under /api path
app.use("/api", generationRouter);

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
app.listen(port, () => {
  console.log(`🚀 Generation server listening on http://localhost:${port}`);
});
