import { copy as zh } from './zh'
export const copy = {
  title: 'Modèle de chat local',
  missing: 'Non téléchargé',
  checking: 'Vérification SHA-256…',
  downloading: 'Téléchargement {n}%',
  paused: 'En pause {n}%',
  ready: 'Prêt',
  error: 'Erreur',
  download: 'Télécharger',
  cancel: 'Annuler',
  resume: 'Reprendre',
  remove: 'Supprimer le modèle',
  keepHot: 'Garder en mémoire (minutes)',
  thinking: 'Raisonnement (plus lent)',
  autoDownload: 'Télécharger le modèle si nécessaire',
  advanced: 'Avancé',
  threads: 'Threads CPU',
  gpu: 'Moteur',
  context: 'Tokens de contexte',
  limits:
    'Texte uniquement, images non prises en charge. Déconseillé pour le code, les longues conversations ou le raisonnement complexe.',
  license:
    'LFM Open License v1.0 : au-delà de 10 millions USD de chiffre annuel, un accord distinct avec Liquid AI est nécessaire.',
  gpuWarning:
    'CPU par défaut. Vulkan a planté sur Radeon 780M lors des tests ; un moteur GPU nécessite un environnement compatible installé séparément.',
  offline: 'Hors ligne. Connectez-vous pour télécharger le modèle local.',
  metered:
    'Réseau limité : téléchargement automatique en pause. Téléchargez manuellement pour continuer.',
} satisfies Record<keyof typeof zh, string>
