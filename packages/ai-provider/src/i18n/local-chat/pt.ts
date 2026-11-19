import { copy as zh } from './zh'
export const copy = {
  title: 'Modelo de chat local',
  missing: 'Não baixado',
  checking: 'Verificando SHA-256…',
  downloading: 'Baixando {n}%',
  paused: 'Pausado {n}%',
  ready: 'Pronto',
  error: 'Erro',
  download: 'Baixar',
  cancel: 'Cancelar',
  resume: 'Retomar',
  remove: 'Excluir modelo',
  keepHot: 'Manter na memória (minutos)',
  thinking: 'Raciocínio (mais lento)',
  autoDownload: 'Baixar modelo quando necessário',
  advanced: 'Avançado',
  threads: 'Threads de CPU',
  gpu: 'Motor',
  context: 'Tokens de contexto',
  limits:
    'Somente texto, imagens ainda não suportadas. Não recomendado para código, conversas longas ou raciocínio complexo.',
  license:
    'LFM Open License v1.0: receita anual acima de 10 milhões USD exige acordo separado com a Liquid AI.',
  gpuWarning:
    'CPU por padrão. Vulkan falhou na Radeon 780M nos testes; motores GPU exigem ambiente compatível instalado separadamente.',
  offline: 'Sem conexão. Conecte-se para baixar o modelo local.',
  metered: 'Rede limitada: download automático pausado. Baixe manualmente para continuar.',
} satisfies Record<keyof typeof zh, string>
