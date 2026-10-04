export interface PatchPreset {
  id: string;
  name: string;
  description: string;
  zhName?: string;
  zhDescription?: string;
  provider: string;
  modelPattern: string;
  snippet: Record<string, unknown>;
}

export const MODEL_PATCH_PRESETS: PatchPreset[] = [
  {
    id: "nvidia-llama-3.3-70b",
    name: "Llama 3.3 70B Instruct",
    zhName: "Llama 3.3 70B Instruct（旗舰指令模型）",
    description: "Meta's flagship open-weights instruct model on NVIDIA NIM (128K context, tools)",
    zhDescription: "Meta 开源旗舰指令模型（128K 上下文，工具调用与结构化输出）",
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
    zhName: "Llama 3.2 11B / 90B Vision（多模态视觉）",
    description: "Meta Multimodal Vision models on NVIDIA NIM (128K context, vision enabled)",
    zhDescription: "Meta 多模态视觉模型（128K 上下文，图像理解）",
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
    zhName: "DeepSeek R1（思考与长推理模型）",
    description: "DeepSeek reasoning model with thinking capabilities and 16K output token budget",
    zhDescription: "DeepSeek 推理大模型，支持显式思考链，16K 最大输出 Token",
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
    zhName: "Llama 3.1 Nemotron 70B Instruct（NVIDIA 对齐调优）",
    description: "NVIDIA's customized reasoning and alignment-tuned model with 128K context",
    zhDescription: "NVIDIA 官方强化对齐模型，高质量推理与指令跟随（128K 上下文）",
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
    zhName: "通义千问 Qwen 2.5 VL 72B（视觉多模态）",
    description:
      "Alibaba multimodal vision-language model with document and high-res image understanding",
    zhDescription: "阿里通义千问视觉语言大模型，文档与高分辨率图像解析（128K 上下文）",
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
    zhName: "NVIDIA NIM 通用兜底规则 (*)",
    description: "Fallback patch applied to every NVIDIA NIM model lacking specific metadata",
    zhDescription: "为所有缺少详细元数据的 NVIDIA NIM 模型提供 32K 基础上下文与工具支持兜底",
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

export function getLocalizedPatchPresets(isZh: boolean): PatchPreset[] {
  return MODEL_PATCH_PRESETS.map((preset) => ({
    ...preset,
    name: isZh && preset.zhName ? preset.zhName : preset.name,
    description: isZh && preset.zhDescription ? preset.zhDescription : preset.description,
  }));
}
