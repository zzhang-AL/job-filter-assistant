// 批量导出用的详细 CSV（Excel / WPS 可直接打开）：纯函数，不依赖界面状态
import { VERDICT_LABELS, normalizeGreetings } from '../common/ai/prompts.js';
import { fmtTime } from './ui-common.js';

// 生成详细 CSV：按「基本信息 / 岗位要求 / 公司信息 / AI匹配分析 / 招呼语 / 其他」分类排列列
export function buildDetailedCsv(items) {
  const cols = [
    // —— 分类/优先级 ——
    ['平台', (j) => (j.platform === 'boss' ? 'BOSS直聘' : '前程无忧51job')],
    ['匹配档次', (j) => (j.match ? VERDICT_LABELS[j.match.verdict] || j.match.verdict : '未分析')],
    ['匹配分', (j) => (j.match ? j.match.score : '')],
    ['是否收藏', (j) => (j.star ? '★' : '')],
    // —— 基本信息 ——
    ['岗位名称', (j) => j.title],
    ['薪资', (j) => j.salaryText],
    ['薪资下限(K/月)', (j) => (j.salaryMinK != null ? j.salaryMinK : '')],
    ['薪资上限(K/月)', (j) => (j.salaryMaxK != null ? j.salaryMaxK : '')],
    ['城市', (j) => j.city],
    ['区域', (j) => j.district],
    // —— 岗位要求 ——
    ['工作地址', (j) => j.address],
    ['工作经验', (j) => j.experience],
    ['JD写明经验', (j) => j.experienceJd],
    ['学历要求', (j) => j.degree],
    ['技能', (j) => joinList(j.skills)],
    ['岗位标签', (j) => joinList(j.tags)],
    ['福利', (j) => joinList(j.welfare)],
    // —— 公司信息 ——
    ['公司名称', (j) => j.company],
    ['所属行业', (j) => j.companyIndustry],
    ['公司规模', (j) => j.companyScale],
    ['公司性质', (j) => j.companyType],
    ['融资阶段', (j) => j.companyStage],
    ['HR', (j) => j.hrName],
    ['HR职位', (j) => j.hrTitle],
    ['HR活跃', (j) => j.hrActiveText || (j.hrOnline ? '在线' : '')],
    ['沟通状态', (j) => (j.contacted === 'job' ? '已沟通' : j.contacted === 'company' ? '已沟通该公司' : '')],
    ['活跃观测时间', (j) => fmtTime(j.hrActiveAt)],
    // —— AI 匹配分析 ——
    ['一句话总评', (j) => (j.match ? j.match.summary : '')],
    ['契合点', (j) => (j.match ? joinList(j.match.reasons) : '')],
    ['差距/需补齐', (j) => (j.match ? joinList(j.match.gaps) : '')],
    ['风险提示', (j) => (j.match ? joinList(j.match.risks) : '')],
    // —— 招呼语 ——
    ['招呼语(标准版)', (j) => (j.greetingDraft || (j.match ? normalizeGreetings(j.match).standard : ''))],
    // —— 其他 ——
    ['岗位描述', (j) => j.description],
    ['收录时间', (j) => fmtTime(j.savedAt)],
    ['最近出现', (j) => fmtTime(j.lastSeenAt)],
    ['岗位链接', (j) => j.url],
  ];
  const head = cols.map((c) => csvCell(c[0])).join(',');
  const rows = items.map((j) => cols.map((c) => csvCell(c[1](j))).join(','));
  return [head, ...rows].join('\r\n');
}

function joinList(x) {
  return Array.isArray(x) ? x.filter(Boolean).join('、') : x == null ? '' : String(x);
}
function csvCell(v) {
  const s = v == null ? '' : String(v);
  // 单元格内换行/逗号/引号：用双引号包裹并转义内部引号
  return `"${s.replace(/"/g, '""')}"`;
}

