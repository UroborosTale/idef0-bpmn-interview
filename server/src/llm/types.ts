export interface ExtractedRole {
  name: string;
  kind: "internal" | "external";
  source_fragment_id: string;
  quote: string;
  confidence: number;
}

export interface ExtractedSystem {
  name: string;
  source_fragment_id: string;
  quote: string;
  confidence: number;
}

export interface ExtractedData {
  name: string;
  kind: "document" | "data";
  source_fragment_id: string;
  quote: string;
  confidence: number;
}

export interface ExtractedControl {
  name: string;
  kind: "regulation" | "rule" | "norm";
  source_fragment_id: string;
  quote: string;
  confidence: number;
}

export interface ExtractedNode {
  type: "task" | "event" | "gateway" | "subprocess";
  subtype?: string;
  name: string; // глагол в инфинитиве + объект
  role_name?: string | null;
  system_names?: string[];
  input_names?: string[];
  output_names?: string[];
  control_names?: string[];
  duration?: string | null;
  frequency?: string | null;
  condition_branches?: { condition: string; next_hint?: string }[];
  order_hint: number; // относительный порядок в рамках фрагмента/чанка
  source_fragment_id: string;
  quote: string;
  confidence: number;
}

export interface ExtractedFlowHint {
  from_order_hint: number;
  to_order_hint: number;
  condition?: string | null;
  source_fragment_id: string;
  quote: string;
}

export interface ExtractedStatement {
  kind: "problem" | "proposal";
  text: string;
  source_fragment_id: string;
  quote: string;
}

export interface ExtractionChunkResult {
  roles: ExtractedRole[];
  systems: ExtractedSystem[];
  data: ExtractedData[];
  controls: ExtractedControl[];
  nodes: ExtractedNode[];
  flows: ExtractedFlowHint[];
  statements: ExtractedStatement[];
  process_hints: {
    goal?: string | null;
    trigger?: string | null;
    result?: string | null;
  };
}

export interface LLMFragmentInput {
  id: string;
  speaker: string;
  speaker_label?: string;
  text: string;
}

export interface LLMProvider {
  readonly name: string;
  extractChunk(
    fragments: LLMFragmentInput[],
    context: { processName: string; modelType: "AS-IS" | "TO-BE"; fewShotContext?: string },
    opts?: { model?: string }
  ): Promise<ExtractionChunkResult>;
  /** ФТ-М9.5.2: распознавание схемы (фото/скан) мультимодальной моделью в PLM — есть только у провайдеров с поддержкой изображений. */
  recognizeDiagramImage?(
    imageBase64: string,
    mimeType: string,
    context: { processName: string; modelType: "AS-IS" | "TO-BE" }
  ): Promise<ExtractionChunkResult>;
}
