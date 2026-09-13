import { buildAppUrl } from "@/lib/app-origin";
import { routes } from "@/lib/routes";

export type MeetingMinutesTask = {
  id: string;
  title: string;
  project: { id: string; name: string } | null;
};

export type MeetingMinutesSource = {
  id: string;
  topic: string;
  rangeStart: string;
  rangeEnd: string;
  minutes: string;
  participants: { id: string; displayName: string; status: string }[];
  tasks: MeetingMinutesTask[];
  segments: { personId: string; content: string; task: MeetingMinutesTask | null }[];
};

function escapeText(value: string) {
  return value.replace(/\r\n?/g, "\n").replace(/([\\`*_[\]{}()#+.!|~<>-])/g, "\\$1");
}

function inlineText(value: string) {
  return escapeText(value).replace(/\n/g, " ");
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

export function formatMeetingMinutes(source: MeetingMinutesSource, appOrigin?: string | null) {
  const taskLink = (task: MeetingMinutesTask) => {
    const link = `[${inlineText(task.title)}](${buildAppUrl(routes.progress.taskDetail(task.id), appOrigin)})`;
    return task.project
      ? `[${inlineText(task.project.name)}](${buildAppUrl(routes.progress.projectDetail(task.project.id), appOrigin)})/${link}`
      : link;
  };
  const personName = (person: MeetingMinutesSource["participants"][number]) =>
    inlineText(`${person.displayName}${person.status === "INACTIVE" ? "（已停用）" : ""}`);
  const segmentsByPerson = new Map<string, MeetingMinutesSource["segments"]>();
  for (const segment of source.segments) {
    const records = segmentsByPerson.get(segment.personId) ?? [];
    records.push(segment);
    segmentsByPerson.set(segment.personId, records);
  }
  const reports = source.participants.flatMap((person) => {
    const records = segmentsByPerson.get(person.id) ?? [];
    return [
      `* ${personName(person)}：`,
      ...(records.length ? records.map((segment) => {
        const content = escapeText(segment.content.trim() || "未填写投入内容").replace(/\n/g, "\n      ");
        return `    * ${segment.task ? `${taskLink(segment.task)}：` : ""}${content}`;
      }) : ["    * 本工作区间暂无投入记录"]),
    ];
  });
  return [
    `# ${inlineText(source.topic)}`, "",
    `+ 时间：${dateTime(source.rangeStart)} 至 ${dateTime(source.rangeEnd)}（工作区间，北京时间）`,
    `+ 参与人员：${source.participants.map(personName).join("、") || "暂无参与人员"}`,
    `+ [系统中的会议链接](${buildAppUrl(routes.progress.meetingDetail(source.id), appOrigin)})`, "",
    "## 进度汇报", "", "### 进行中的任务", "",
    ...(source.tasks.length ? source.tasks.map((task) => `* ${taskLink(task)}`) : ["* 暂无进行中的任务"]), "",
    "### 个人进度汇报", "", ...(reports.length ? reports : ["* 暂无参与人员"]), "",
    "其他：", "", source.minutes.trim() || "待补充", "",
    "## 下周安排", "",
    ...source.participants.flatMap((person) => [`* ${personName(person)}`, "    * 待补充"]), "",
  ].join("\n");
}
