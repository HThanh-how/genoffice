import type { zh } from './zh'

export const strings = {
  title: '이 파일 작업을 허용할까요?',
  approve: '승인',
  deny: '거부',
  create_folder: '폴더 만들기',
  move_file: '파일 이동 또는 이름 변경',
  delete_file: '시스템 휴지통으로 이동',
  list_folder: '폴더 목록',
  export_pdf: '저장된 파일을 PDF로 내보내기',
} satisfies Record<keyof typeof zh, string>
