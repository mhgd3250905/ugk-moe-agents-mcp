import fs from "node:fs";
import path from "node:path";
import { readSettingsJson, resolveSettingsPath, updateSettingsJson, type SettingsIoDeps } from "./settings-io.ts";

export const SUPPORTED_UI_LANGUAGES = [
	{ code: "zh-CN", label: "简体中文", aliases: ["zh", "zh-cn", "cn", "chinese", "中文", "简体中文"] },
	{ code: "en-US", label: "English", aliases: ["en", "en-us", "english", "英文"] },
	{ code: "ja-JP", label: "日本語", aliases: ["ja", "ja-jp", "japanese", "日本語", "日语", "日文"] },
	{ code: "ko-KR", label: "한국어", aliases: ["ko", "ko-kr", "korean", "한국어", "韩语", "韓國語"] },
	{ code: "fr-FR", label: "Français", aliases: ["fr", "fr-fr", "french", "français", "francais", "法语"] },
	{ code: "de-DE", label: "Deutsch", aliases: ["de", "de-de", "german", "deutsch", "德语"] },
	{ code: "es-ES", label: "Español", aliases: ["es", "es-es", "spanish", "español", "espanol", "西班牙语"] },
	{ code: "pt-BR", label: "Português", aliases: ["pt", "pt-br", "portuguese", "português", "portugues", "葡萄牙语"] },
	{ code: "ru-RU", label: "Русский", aliases: ["ru", "ru-ru", "russian", "русский", "俄语"] },
] as const;

export type UiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number]["code"];

const UI_LANGUAGE_KEY = "uiLanguage";
const TRANSLATIONS: Record<string, Partial<Record<UiLanguage, string>>> = {
	"查看状态": { "ja-JP": "状態を表示", "ko-KR": "상태 보기", "fr-FR": "Voir l'état", "de-DE": "Status anzeigen", "es-ES": "Ver estado", "pt-BR": "Ver status", "ru-RU": "Показать статус" },
	"开启": { "ja-JP": "オン", "ko-KR": "켜기", "fr-FR": "Activer", "de-DE": "Einschalten", "es-ES": "Activar", "pt-BR": "Ativar", "ru-RU": "Включить" },
	"关闭": { "ja-JP": "オフ", "ko-KR": "끄기", "fr-FR": "Désactiver", "de-DE": "Ausschalten", "es-ES": "Desactivar", "pt-BR": "Desativar", "ru-RU": "Выключить" },
	"清除": { "ja-JP": "クリア", "ko-KR": "지우기", "fr-FR": "Effacer", "de-DE": "Löschen", "es-ES": "Borrar", "pt-BR": "Limpar", "ru-RU": "Очистить" },
	"退出": { "ja-JP": "終了", "ko-KR": "종료", "fr-FR": "Quitter", "de-DE": "Beenden", "es-ES": "Salir", "pt-BR": "Sair", "ru-RU": "Выйти" },
	"返回": { "ja-JP": "戻る", "ko-KR": "뒤로", "fr-FR": "Retour", "de-DE": "Zurück", "es-ES": "Volver", "pt-BR": "Voltar", "ru-RU": "Назад" },
	"设置界面语言": { "ja-JP": "UI 言語を設定", "ko-KR": "UI 언어 설정", "fr-FR": "Définir la langue de l'UI", "de-DE": "UI-Sprache festlegen", "es-ES": "Definir idioma de la UI", "pt-BR": "Definir idioma da UI", "ru-RU": "Выбрать язык интерфейса" },
	"设置回答语言": { "ja-JP": "返信言語を設定", "ko-KR": "응답 언어 설정", "fr-FR": "Définir la langue de réponse", "de-DE": "Antwortsprache festlegen", "es-ES": "Definir idioma de respuesta", "pt-BR": "Definir idioma de resposta", "ru-RU": "Выбрать язык ответов" },
	"自动放行": { "ja-JP": "自動承認", "ko-KR": "자동 승인", "fr-FR": "Approbation automatique", "de-DE": "Autopilot", "es-ES": "Aprobación automática", "pt-BR": "Aprovação automática", "ru-RU": "Автоподтверждение" },
	"回答语言": { "ja-JP": "返信言語", "ko-KR": "응답 언어", "fr-FR": "Langue de réponse", "de-DE": "Antwortsprache", "es-ES": "Idioma de respuesta", "pt-BR": "Idioma de resposta", "ru-RU": "Язык ответов" },
	"界面语言": { "ja-JP": "UI 言語", "ko-KR": "UI 언어", "fr-FR": "Langue de l'UI", "de-DE": "UI-Sprache", "es-ES": "Idioma de la UI", "pt-BR": "Idioma da UI", "ru-RU": "Язык интерфейса" },
	"选择界面语言": { "ja-JP": "UI 言語を選択", "ko-KR": "UI 언어 선택", "fr-FR": "Choisir la langue de l'UI", "de-DE": "UI-Sprache auswählen", "es-ES": "Elegir idioma de la UI", "pt-BR": "Escolher idioma da UI", "ru-RU": "Выберите язык интерфейса" },
	"界面语言已设为": { "ja-JP": "UI 言語を設定しました", "ko-KR": "UI 언어 설정됨", "fr-FR": "Langue de l'UI définie", "de-DE": "UI-Sprache gesetzt", "es-ES": "Idioma de la UI definido", "pt-BR": "Idioma da UI definido", "ru-RU": "Язык интерфейса установлен" },
	"当前界面语言": { "ja-JP": "現在の UI 言語", "ko-KR": "현재 UI 언어", "fr-FR": "Langue actuelle de l'UI", "de-DE": "Aktuelle UI-Sprache", "es-ES": "Idioma actual de la UI", "pt-BR": "Idioma atual da UI", "ru-RU": "Текущий язык интерфейса" },
	"界面语言已清除,回到默认: 简体中文": { "ja-JP": "UI 言語をクリアしました。既定: 簡体字中国語", "ko-KR": "UI 언어를 지웠습니다. 기본값: 중국어 간체", "fr-FR": "Langue de l'UI effacée; retour par défaut : chinois simplifié", "de-DE": "UI-Sprache gelöscht; zurück zum Standard: Vereinfachtes Chinesisch", "es-ES": "Idioma de la UI borrado; vuelve al predeterminado: chino simplificado", "pt-BR": "Idioma da UI limpo; volta ao padrão: chinês simplificado", "ru-RU": "Язык интерфейса очищен; по умолчанию: упрощенный китайский" },

	"未选择模型": { "ja-JP": "モデル未選択", "ko-KR": "모델 선택 안 됨", "fr-FR": "modèle non sélectionné", "de-DE": "kein Modell ausgewählt", "es-ES": "modelo no seleccionado", "pt-BR": "modelo não selecionado", "ru-RU": "модель не выбрана" },
	"工作区": { "ja-JP": "ワークスペース", "ko-KR": "작업공간", "fr-FR": "Espace de travail", "de-DE": "Arbeitsbereich", "es-ES": "Espacio de trabajo", "pt-BR": "Área de trabalho", "ru-RU": "Рабочая область" },
	"代理": { "ja-JP": "エージェント", "ko-KR": "에이전트", "fr-FR": "Agent", "de-DE": "Agent", "es-ES": "Agente", "pt-BR": "Agente", "ru-RU": "Агент" },
	"终端编码代理": { "ja-JP": "ターミナル coding agent", "ko-KR": "터미널 coding agent", "fr-FR": "Agent de codage terminal", "de-DE": "Terminal-Coding-Agent", "es-ES": "Agente de código en terminal", "pt-BR": "Agente de código no terminal", "ru-RU": "Терминальный coding agent" },
	"能力": { "ja-JP": "機能", "ko-KR": "기능", "fr-FR": "Capacités", "de-DE": "Funktionen", "es-ES": "Capacidades", "pt-BR": "Recursos", "ru-RU": "Возможности" },
	"快捷操作": { "ja-JP": "クイック操作", "ko-KR": "빠른 작업", "fr-FR": "Actions rapides", "de-DE": "Schnellaktionen", "es-ES": "Acciones rápidas", "pt-BR": "Ações rápidas", "ru-RU": "Быстрые действия" },
	"模型": { "ja-JP": "モデル", "ko-KR": "모델", "fr-FR": "Modèle", "de-DE": "Modell", "es-ES": "Modelo", "pt-BR": "Modelo", "ru-RU": "Модель" },
	"欢迎回来。": { "ja-JP": "おかえりなさい。", "ko-KR": "다시 오신 것을 환영합니다.", "fr-FR": "Bon retour.", "de-DE": "Willkommen zurück.", "es-ES": "Bienvenido de nuevo.", "pt-BR": "Bem-vindo de volta.", "ru-RU": "С возвращением." },
	"◆ 入门提示": { "ja-JP": "◆ はじめに", "ko-KR": "◆ 시작하기", "fr-FR": "◆ Premiers pas", "de-DE": "◆ Erste Schritte", "es-ES": "◆ Primeros pasos", "pt-BR": "◆ Primeiros passos", "ru-RU": "◆ Начало работы" },
	"› /plan      修改前先拟计划": { "ja-JP": "› /plan      編集前に計画", "ko-KR": "› /plan      수정 전 계획", "fr-FR": "› /plan      Planifier avant modification", "de-DE": "› /plan      Vor Änderungen planen", "es-ES": "› /plan      Planificar antes de editar", "pt-BR": "› /plan      Planeje antes de editar", "ru-RU": "› /plan      План перед изменениями" },
	"› /implement 运行引导流程": { "ja-JP": "› /implement ガイド付き実行", "ko-KR": "› /implement 안내 흐름 실행", "fr-FR": "› /implement Lancer le flux guidé", "de-DE": "› /implement Geführten Ablauf starten", "es-ES": "› /implement Ejecutar flujo guiado", "pt-BR": "› /implement Executar fluxo guiado", "ru-RU": "› /implement Запустить сценарий" },
	"› /doctor 环境配置引导": { "ja-JP": "› /doctor 環境設定ガイド", "ko-KR": "› /doctor 환경 설정 안내", "fr-FR": "› /doctor Aide environnement", "de-DE": "› /doctor Umgebungshilfe", "es-ES": "› /doctor Ayuda de entorno", "pt-BR": "› /doctor Ajuda de ambiente", "ru-RU": "› /doctor Помощь с окружением" },
	"◆ 最近更新": { "ja-JP": "◆ 最近の更新", "ko-KR": "◆ 최근 업데이트", "fr-FR": "◆ Mises à jour récentes", "de-DE": "◆ Letzte Updates", "es-ES": "◆ Actualizaciones recientes", "pt-BR": "◆ Atualizações recentes", "ru-RU": "◆ Последние обновления" },
	"› task 显示 worker 进度": { "ja-JP": "› task が worker 進捗を表示", "ko-KR": "› task가 worker 진행률 표시", "fr-FR": "› task affiche la progression worker", "de-DE": "› task zeigt Worker-Fortschritt", "es-ES": "› task muestra progreso del worker", "pt-BR": "› task mostra progresso do worker", "ru-RU": "› task показывает прогресс worker" },
	"› footer 显示用量和就绪状态": { "ja-JP": "› footer が使用量と状態を表示", "ko-KR": "› footer가 사용량과 준비 상태 표시", "fr-FR": "› footer affiche usage et état", "de-DE": "› footer zeigt Nutzung und Bereitschaft", "es-ES": "› footer muestra uso y estado", "pt-BR": "› footer mostra uso e prontidão", "ru-RU": "› footer показывает usage и готовность" },
	"› @agent 委派专注任务": { "ja-JP": "› @agent でタスク委任", "ko-KR": "› @agent로 집중 작업 위임", "fr-FR": "› @agent délègue une tâche ciblée", "de-DE": "› @agent delegiert fokussierte Arbeit", "es-ES": "› @agent delega tareas enfocadas", "pt-BR": "› @agent delega tarefas focadas", "ru-RU": "› @agent делегирует задачу" },

	"模块": { "ja-JP": "モジュール", "ko-KR": "모듈", "fr-FR": "Module", "de-DE": "Modul", "es-ES": "Módulo", "pt-BR": "Módulo", "ru-RU": "Модуль" },
	"状态": { "ja-JP": "状態", "ko-KR": "상태", "fr-FR": "État", "de-DE": "Status", "es-ES": "Estado", "pt-BR": "Status", "ru-RU": "Статус" },
	"检查": { "ja-JP": "チェック", "ko-KR": "검사", "fr-FR": "Vérification", "de-DE": "Prüfung", "es-ES": "Comprobación", "pt-BR": "Verificação", "ru-RU": "Проверка" },
	"结果": { "ja-JP": "結果", "ko-KR": "결과", "fr-FR": "Résultat", "de-DE": "Ergebnis", "es-ES": "Resultado", "pt-BR": "Resultado", "ru-RU": "Результат" },
	"标题": { "ja-JP": "タイトル", "ko-KR": "제목", "fr-FR": "Titre", "de-DE": "Titel", "es-ES": "Título", "pt-BR": "Título", "ru-RU": "Заголовок" },
	"地址": { "ja-JP": "アドレス", "ko-KR": "주소", "fr-FR": "Adresse", "de-DE": "Adresse", "es-ES": "Dirección", "pt-BR": "Endereço", "ru-RU": "Адрес" },
	"连接": { "ja-JP": "接続", "ko-KR": "연결", "fr-FR": "Connexion", "de-DE": "Verbindung", "es-ES": "Conexión", "pt-BR": "Conexão", "ru-RU": "Соединение" },
	"页面": { "ja-JP": "ページ", "ko-KR": "페이지", "fr-FR": "Pages", "de-DE": "Seiten", "es-ES": "Páginas", "pt-BR": "Páginas", "ru-RU": "Страницы" },
	"在线": { "ja-JP": "オンライン", "ko-KR": "온라인", "fr-FR": "En ligne", "de-DE": "Online", "es-ES": "En línea", "pt-BR": "Online", "ru-RU": "В сети" },
	"无法连接": { "ja-JP": "接続不可", "ko-KR": "연결 불가", "fr-FR": "Injoignable", "de-DE": "Nicht erreichbar", "es-ES": "No accesible", "pt-BR": "Inacessível", "ru-RU": "Недоступно" },
	"错误": { "ja-JP": "エラー", "ko-KR": "오류", "fr-FR": "Erreur", "de-DE": "Fehler", "es-ES": "Error", "pt-BR": "Erro", "ru-RU": "Ошибка" },
	"连接失败": { "ja-JP": "接続失敗", "ko-KR": "연결 실패", "fr-FR": "Échec de connexion", "de-DE": "Verbindung fehlgeschlagen", "es-ES": "Conexión fallida", "pt-BR": "Falha na conexão", "ru-RU": "Сбой подключения" },
	"(无标题)": { "ja-JP": "(無題)", "ko-KR": "(제목 없음)", "fr-FR": "(sans titre)", "de-DE": "(ohne Titel)", "es-ES": "(sin título)", "pt-BR": "(sem título)", "ru-RU": "(без заголовка)" },
	"👉 下一步:": { "ja-JP": "👉 次の手順:", "ko-KR": "👉 다음 단계:", "fr-FR": "👉 Étapes suivantes :", "de-DE": "👉 Nächste Schritte:", "es-ES": "👉 Próximos pasos:", "pt-BR": "👉 Próximos passos:", "ru-RU": "👉 Следующие шаги:" },
	"✨ 核心检查全部通过。": { "ja-JP": "✨ コアチェックはすべて成功しました。", "ko-KR": "✨ 핵심 검사를 모두 통과했습니다.", "fr-FR": "✨ Toutes les vérifications principales ont réussi.", "de-DE": "✨ Alle Kernprüfungen bestanden.", "es-ES": "✨ Todas las comprobaciones principales pasaron.", "pt-BR": "✨ Todas as verificações principais passaram.", "ru-RU": "✨ Все основные проверки пройдены." },

	"允许": { "ja-JP": "許可", "ko-KR": "허용", "fr-FR": "Autoriser", "de-DE": "Erlauben", "es-ES": "Permitir", "pt-BR": "Permitir", "ru-RU": "Разрешить" },
	"拒绝": { "ja-JP": "拒否", "ko-KR": "거부", "fr-FR": "Refuser", "de-DE": "Ablehnen", "es-ES": "Denegar", "pt-BR": "Negar", "ru-RU": "Отклонить" },
	"允许一次": { "ja-JP": "一度だけ許可", "ko-KR": "한 번 허용", "fr-FR": "Autoriser une fois", "de-DE": "Einmal erlauben", "es-ES": "Permitir una vez", "pt-BR": "Permitir uma vez", "ru-RU": "Разрешить один раз" },
	"本会话允许": { "ja-JP": "このセッションで許可", "ko-KR": "이 세션에서 허용", "fr-FR": "Autoriser pour cette session", "de-DE": "Für diese Sitzung erlauben", "es-ES": "Permitir en esta sesión", "pt-BR": "Permitir nesta sessão", "ru-RU": "Разрешить для этого сеанса" },
	"允许 MCP server?": { "ja-JP": "MCP server を許可しますか?", "ko-KR": "MCP server를 허용할까요?", "fr-FR": "Autoriser le server MCP ?", "de-DE": "MCP-server erlauben?", "es-ES": "¿Permitir server MCP?", "pt-BR": "Permitir server MCP?", "ru-RU": "Разрешить MCP server?" },
	"允许 MCP tool?": { "ja-JP": "MCP tool を許可しますか?", "ko-KR": "MCP tool을 허용할까요?", "fr-FR": "Autoriser le tool MCP ?", "de-DE": "MCP-tool erlauben?", "es-ES": "¿Permitir tool MCP?", "pt-BR": "Permitir tool MCP?", "ru-RU": "Разрешить MCP tool?" },
	"来自": { "ja-JP": "スコープ", "ko-KR": "출처", "fr-FR": "Depuis", "de-DE": "Aus", "es-ES": "Desde", "pt-BR": "De", "ru-RU": "Из" },
	"配置的 server 想启动": { "ja-JP": "設定の server が起動しようとしています", "ko-KR": "설정의 server가 시작하려고 합니다", "fr-FR": "server configuré veut démarrer", "de-DE": "konfigurierter server möchte starten", "es-ES": "server configurado quiere iniciar", "pt-BR": "server configurado quer iniciar", "ru-RU": "настроенный server хочет запуститься" },
	"原因": { "ja-JP": "理由", "ko-KR": "이유", "fr-FR": "Raison", "de-DE": "Grund", "es-ES": "Motivo", "pt-BR": "Motivo", "ru-RU": "Причина" },
	"运行中...": { "ja-JP": "実行中...", "ko-KR": "실행 중...", "fr-FR": "exécution...", "de-DE": "läuft...", "es-ES": "ejecutando...", "pt-BR": "executando...", "ru-RU": "выполняется..." },
	"完成": { "ja-JP": "完了", "ko-KR": "완료", "fr-FR": "terminé", "de-DE": "fertig", "es-ES": "completado", "pt-BR": "concluído", "ru-RU": "готово" },
	"行": { "ja-JP": "行", "ko-KR": "줄", "fr-FR": "lignes", "de-DE": "Zeilen", "es-ES": "líneas", "pt-BR": "linhas", "ru-RU": "строк" },
	"已截断": { "ja-JP": "切り詰め済み", "ko-KR": "잘림", "fr-FR": "tronqué", "de-DE": "gekürzt", "es-ES": "truncado", "pt-BR": "truncado", "ru-RU": "усечено" },
	"... 更多输出": { "ja-JP": "... さらに出力", "ko-KR": "... 출력 더 있음", "fr-FR": "... sortie supplémentaire", "de-DE": "... weitere Ausgabe", "es-ES": "... más salida", "pt-BR": "... mais saída", "ru-RU": "... еще вывод" },
	"编辑中...": { "ja-JP": "編集中...", "ko-KR": "편집 중...", "fr-FR": "édition...", "de-DE": "bearbeitet...", "es-ES": "editando...", "pt-BR": "editando...", "ru-RU": "редактирование..." },
	"已应用": { "ja-JP": "適用済み", "ko-KR": "적용됨", "fr-FR": "appliqué", "de-DE": "angewendet", "es-ES": "aplicado", "pt-BR": "aplicado", "ru-RU": "применено" },
	"填写其他答案。": { "ja-JP": "別の回答を入力。", "ko-KR": "다른 답변 입력.", "fr-FR": "Saisir une autre réponse.", "de-DE": "Andere Antwort eingeben.", "es-ES": "Escribir otra respuesta.", "pt-BR": "Digitar outra resposta.", "ru-RU": "Ввести другой ответ." },
	"错误:UI 不可用(当前为非交互模式)": { "ja-JP": "エラー:UI が利用できません(現在は非対話モード)", "ko-KR": "오류:UI를 사용할 수 없습니다(현재 비대화 모드)", "fr-FR": "Erreur : UI indisponible (mode non interactif)", "de-DE": "Fehler: UI nicht verfügbar (nicht interaktiver Modus)", "es-ES": "Error: UI no disponible (modo no interactivo)", "pt-BR": "Erro: UI indisponível (modo não interativo)", "ru-RU": "Ошибка: UI недоступен (неинтерактивный режим)" },
	"错误:没有提供问题": { "ja-JP": "エラー:質問がありません", "ko-KR": "오류: 질문이 없습니다", "fr-FR": "Erreur : aucune question fournie", "de-DE": "Fehler: keine Fragen angegeben", "es-ES": "Error: no se proporcionaron preguntas", "pt-BR": "Erro: nenhuma pergunta fornecida", "ru-RU": "Ошибка: вопросы не указаны" },
	"错误:无效的问卷选择": { "ja-JP": "エラー:無効な questionnaire 選択", "ko-KR": "오류: 잘못된 questionnaire 선택", "fr-FR": "Erreur : sélection de questionnaire invalide", "de-DE": "Fehler: ungültige questionnaire-Auswahl", "es-ES": "Error: selección de questionnaire no válida", "pt-BR": "Erro: seleção de questionnaire inválida", "ru-RU": "Ошибка: недопустимый выбор questionnaire" },
	"个问题": { "ja-JP": "問", "ko-KR": "개 질문", "fr-FR": "questions", "de-DE": "Fragen", "es-ES": "preguntas", "pt-BR": "perguntas", "ru-RU": "вопросов" },
	"提问中...": { "ja-JP": "質問中...", "ko-KR": "질문 중...", "fr-FR": "question en cours...", "de-DE": "fragt...", "es-ES": "preguntando...", "pt-BR": "perguntando...", "ru-RU": "идет вопрос..." },
	"用户填写": { "ja-JP": "ユーザー入力", "ko-KR": "사용자 입력", "fr-FR": "saisi par l'utilisateur", "de-DE": "Benutzereingabe", "es-ES": "usuario escribió", "pt-BR": "usuário digitou", "ru-RU": "пользователь ввел" },
	"用户选择": { "ja-JP": "ユーザー選択", "ko-KR": "사용자 선택", "fr-FR": "choisi par l'utilisateur", "de-DE": "Benutzerauswahl", "es-ES": "usuario eligió", "pt-BR": "usuário escolheu", "ru-RU": "пользователь выбрал" },
	"继承 main/default": { "ja-JP": "main/default を継承", "ko-KR": "main/default 상속", "fr-FR": "Hériter de main/default", "de-DE": "main/default übernehmen", "es-ES": "Heredar main/default", "pt-BR": "Herdar main/default", "ru-RU": "Наследовать main/default" },
	"继承": { "ja-JP": "継承", "ko-KR": "상속", "fr-FR": "hérité", "de-DE": "geerbt", "es-ES": "heredado", "pt-BR": "herdado", "ru-RU": "наследуется" },
	"列出 subagent 并设置模型": { "ja-JP": "subagent を一覧しモデルを設定", "ko-KR": "subagent 목록 및 모델 설정", "fr-FR": "Lister les subagents et définir leur modèle", "de-DE": "Subagents auflisten und Modell setzen", "es-ES": "Listar subagents y definir modelo", "pt-BR": "Listar subagents e definir modelo", "ru-RU": "Показать subagent и задать модель" },
	"没有找到 subagent。": { "ja-JP": "subagent が見つかりません。", "ko-KR": "subagent를 찾지 못했습니다.", "fr-FR": "Aucun subagent trouvé.", "de-DE": "Keine Subagents gefunden.", "es-ES": "No se encontraron subagents.", "pt-BR": "Nenhum subagent encontrado.", "ru-RU": "subagent не найдены." },
	"子代理": { "ja-JP": "サブエージェント", "ko-KR": "하위 에이전트", "fr-FR": "Subagents", "de-DE": "Subagents", "es-ES": "Subagents", "pt-BR": "Subagents", "ru-RU": "Subagents" },
	"没有可用模型。请先配置 API 或使用 /login。": { "ja-JP": "利用可能なモデルがありません。先に API を設定するか /login を使用してください。", "ko-KR": "사용 가능한 모델이 없습니다. 먼저 API를 설정하거나 /login을 사용하세요.", "fr-FR": "Aucun modèle disponible. Configurez une API ou utilisez /login.", "de-DE": "Keine Modelle verfügbar. API konfigurieren oder /login verwenden.", "es-ES": "No hay modelos disponibles. Configura una API o usa /login.", "pt-BR": "Nenhum modelo disponível. Configure uma API ou use /login.", "ru-RU": "Нет доступных моделей. Настройте API или используйте /login." },
};

function withDefaultExists(deps: SettingsIoDeps): SettingsIoDeps {
	return deps.exists ? deps : { ...deps, exists: fs.existsSync };
}

export function normalizeUiLanguage(value: string | undefined): UiLanguage | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	const match = SUPPORTED_UI_LANGUAGES.find((language) => language.aliases.includes(normalized));
	if (match) return match.code;
	return undefined;
}

export function getUiLanguage(deps: SettingsIoDeps = {}): UiLanguage {
	const settings = readSettingsJson(withDefaultExists(deps));
	const value = settings?.[UI_LANGUAGE_KEY];
	return normalizeUiLanguage(typeof value === "string" ? value : undefined) ?? "zh-CN";
}

export function setUiLanguage(language: string, deps: SettingsIoDeps = {}): UiLanguage | undefined {
	const normalized = normalizeUiLanguage(language);
	if (!normalized) return undefined;
	updateSettingsJson({ [UI_LANGUAGE_KEY]: normalized }, withDefaultExists(deps));
	return normalized;
}

export function clearUiLanguage(deps: SettingsIoDeps = {}): void {
	const settings = readSettingsJson(withDefaultExists(deps));
	if (!settings || !(UI_LANGUAGE_KEY in settings)) return;
	delete settings[UI_LANGUAGE_KEY];
	const settingsPath = resolveSettingsPath(deps);
	const writeFile = deps.writeFile ?? ((p: string, c: string) => fs.writeFileSync(p, c));
	const mkdir = deps.mkdir ?? ((p: string, o: { recursive: true }) => fs.mkdirSync(p, o));
	mkdir(path.dirname(settingsPath), { recursive: true });
	writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

export function formatUiLanguage(language: UiLanguage): string {
	return SUPPORTED_UI_LANGUAGES.find((item) => item.code === language)?.label ?? "简体中文";
}

export function uiText<T>(zhCN: T, enUS: T, language: UiLanguage = getUiLanguage()): T {
	if (language === "zh-CN") return zhCN;
	if (language === "en-US") return enUS;
	if (Array.isArray(zhCN) && Array.isArray(enUS)) {
		return zhCN.map((value, index) =>
			typeof value === "string" ? translateString(value, enUS[index] as string | undefined, language) : enUS[index],
		) as T;
	}
	if (typeof zhCN === "string") return translateString(zhCN, enUS as string | undefined, language) as T;
	return enUS;
}

function translateString(zhCN: string, enUS: string | undefined, language: UiLanguage): string {
	return TRANSLATIONS[zhCN]?.[language] ?? enUS ?? zhCN;
}
