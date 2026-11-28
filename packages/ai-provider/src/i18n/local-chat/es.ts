import { copy as zh } from './zh'
export const copy = {
  noReply: 'El modelo local no respondió tras un reintento. Inténtalo de nuevo.',
  title: 'Modelo de chat local',
  missing: 'Sin descargar',
  checking: 'Verificando SHA-256…',
  downloading: 'Descargando {n}%',
  paused: 'En pausa {n}%',
  ready: 'Listo',
  error: 'Error',
  download: 'Descargar',
  cancel: 'Cancelar',
  resume: 'Continuar',
  remove: 'Eliminar modelo',
  keepHot: 'Mantener en memoria (minutos)',
  thinking: 'Razonamiento (más lento)',
  autoDownload: 'Descargar modelo cuando sea necesario',
  advanced: 'Avanzado',
  threads: 'Hilos de CPU',
  gpu: 'Motor',
  context: 'Tokens de contexto',
  limits:
    'Solo texto, aún sin imágenes. No recomendado para código, conversaciones largas o razonamiento complejo.',
  license:
    'LFM Open License v1.0: ingresos anuales superiores a 10 millones USD requieren un acuerdo separado con Liquid AI.',
  gpuWarning:
    'CPU por defecto. Vulkan falló en Radeon 780M durante las pruebas; los motores GPU requieren un entorno compatible instalado aparte.',
  offline: 'Sin conexión. Conéctate para descargar el modelo local.',
  metered: 'Red de uso medido: descarga automática en pausa. Descarga manualmente para continuar.',
} satisfies Record<keyof typeof zh, string>
