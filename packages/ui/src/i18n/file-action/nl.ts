import type { zh } from './zh'

export const strings = {
  title: 'Deze bestandsactie toestaan?',
  approve: 'Goedkeuren',
  deny: 'Weigeren',
  create_folder: 'Map maken',
  move_file: 'Bestand verplaatsen of hernoemen',
  delete_file: 'Naar systeemprullenbak verplaatsen',
  list_folder: 'Map weergeven',
  export_pdf: 'Opgeslagen bestand als PDF exporteren',
} satisfies Record<keyof typeof zh, string>
