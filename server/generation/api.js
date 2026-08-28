import express from "express";
import { GenerationEngine } from "../../src/generation/engine.js";
import { DesignBriefV1 } from "../../src/generation/types.js";
import { StreamingPlaceholderProvider } from "../assistant/modelProvider.js";

const router = express.Router();
const engine = new GenerationEngine(new StreamingPlaceholderProvider());

router.post("/generate", async (req, res) => {
  try {
    const brief = DesignBriefV1.parse(req.body);
    const phases = [];
    const listener = (event) => {
      phases.push(JSON.stringify(event));
    };
    engine.once("rough", listener);
    engine.once("structure", listener);
    engine.once("detail", listener);
    await engine.generate(brief);
    res.json({ status: "ok", phases });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e?.message ?? "Invalid request" });
  }
});

export default router;
