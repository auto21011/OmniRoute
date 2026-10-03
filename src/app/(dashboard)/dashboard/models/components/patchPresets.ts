export interface PatchPreset {
  id: string;
  name: string;
  description: string;
  provider: string;
  modelPattern: string;
  snippet: Record<string, unknown>;
}

export const MODEL_PATCH_PRESETS: PatchPreset[] = [
  {
    id: "nvidia-llama-3.3-70b",
    name: "Llama 3.3 70B Instruct",
    description: "Meta's flagship open-weights instruct model on NVIDIA NIM (128K context, tools)",
    provider: "nvidia",
    modelPattern: "meta/llama-3.3-70b-instruct",
    snippet: {
      name: "Llama 3.3 70B Instruct",
      displayName: "Llama 3.3 70B Instruct",
      type: "chat",
      context_length: 131072,
      max_output_tokens: 4096,
      supported_parameters: [
        "temperature",
        "top_p",
        "max_tokens",
        "stream",
        "tools",
        "tool_choice",
        "response_format",
        "stop",
        "seed",
      ],
      capabilities: {
        vision: false,
        reasoning: false,
        tool_calling: true,
        structured_output: true,
      },
      input_modalities: ["text"],
      output_modalities: ["text"],
    },
  },
  {
    id: "nvidia-llama-3.2-vision",
    name: "Llama 3.2 11B / 90B Vision",
    description: "Meta Multimodal Vision models on NVIDIA NIM (128K context, vision enabled)",
    provider: "nvidia",
    modelPattern: "meta/llama-3.2-11b-vision-instruct",
    snippet: {
      name: "Llama 3.2 11B Vision Instruct",
      type: "chat",
      context_length: 131072,
      max_output_tokens: 4096,
      supported_parameters: ["temperature", "top_p", "max_tokens", "stream", "stop"],
      capabilities: {
        vision: true,
        reasoning: false,
        tool_calling: false,
      },
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
  },
  {
    id: "nvidia-deepseek-r1",
    name: "DeepSeek R1 (Thinking / Reasoning)",
    description: "DeepSeek reasoning model with thinking capabilities and 16K output token budget",
    provider: "nvidia",
    modelPattern: "deepseek-ai/deepseek-r1",
    snippet: {
      name: "DeepSeek R1",
      type: "chat",
      context_length: 131072,
      max_output_tokens: 16384,
      supported_parameters: [
        "temperature",
        "top_p",
        "max_tokens",
        "stream",
        "thinking",
        "reasoning_effort",
      ],
      capabilities: {
        vision: false,
        reasoning: true,
        thinking: true,
        supportsThinking: true,
        tool_calling: true,
        effort_tiers: ["low", "medium", "high"],
      },
      input_modalities: ["text"],
      output_modalities: ["text"],
    },
  },
  {
    id: "nvidia-nemotron-70b",
    name: "Llama 3.1 Nemotron 70B Instruct",
    description: "NVIDIA's customized reasoning and alignment-tuned model with 128K context",
    provider: "nvidia",
    modelPattern: "nvidia/llama-3.1-nemotron-70b-instruct",
    snippet: {
      name: "Llama 3.1 Nemotron 70B Instruct",
      type: "chat",
      context_length: 131072,
      max_output_tokens: 4096,
      supported_parameters: [
        "temperature",
        "top_p",
        "max_tokens",
        "stream",
        "tools",
        "tool_choice",
        "response_format",
      ],
      capabilities: {
        vision: false,
        reasoning: false,
        tool_calling: true,
        structured_output: true,
      },
      input_modalities: ["text"],
      output_modalities: ["text"],
    },
  },
  {
    id: "nvidia-qwen-2.5-vl",
    name: "Qwen 2.5 VL 72B Instruct (Vision)",
    description:
      "Alibaba multimodal vision-language model with document and high-res image understanding",
    provider: "nvidia",
    modelPattern: "qwen/qwen2.5-vl-72b-instruct",
    snippet: {
      name: "Qwen 2.5 VL 72B Instruct",
      type: "chat",
      context_length: 131072,
      max_output_tokens: 8192,
      supported_parameters: [
        "temperature",
        "top_p",
        "max_tokens",
        "stream",
        "tools",
        "response_format",
      ],
      capabilities: {
        vision: true,
        tool_calling: true,
        structured_output: true,
      },
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
  },
  {
    id: "nvidia-provider-wildcard",
    name: "NVIDIA NIM Global Default (*)",
    description: "Fallback patch applied to every NVIDIA NIM model lacking specific metadata",
    provider: "nvidia",
    modelPattern: "*",
    snippet: {
      context_length: 32768,
      max_output_tokens: 4096,
      supported_parameters: [
        "temperature",
        "top_p",
        "max_tokens",
        "stream",
        "tools",
        "stop",
        "seed",
      ],
      capabilities: {
        tool_calling: true,
        streaming: true,
      },
    },
  },
];
