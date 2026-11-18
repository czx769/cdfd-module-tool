# CDFD 模块规格生成器

将整个文件夹放在一起，用浏览器打开 [index.html](index.html)。页面可以离线运行。

1. 选择 `.drawio` 原文件、draw.io 导出的 UTF-8 XML 或 CDFD XML。多页文件可以选择要导入的图页。也可以载入内置示例，或下载 [师生档案系统 draw.io 示例](student-teacher-cdfd.drawio) 再导入。
2. 在左侧图上点击过程框，右侧会显示对应的类型、前置条件和后置条件。也可以通过画布下方的「过程列表」切换。「模块与存储」用于填写全局声明。连接两个过程的同一条数据流共用一个类型。
3. 点击「导出 .sofl」时，页面会显示待填项。点某一项可跳到表单字段。选择「导出含待填项的草稿」可先保存模板。需要调整生成文本时，可使用「编辑文本」再导出。

「导出图结构 XML」会保存当前图的节点、连线、端口和已填的类型及存储范围。过程的前置条件、后置条件及其他规格正文请用 `.sofl` 保存。导出检查会定位漏填项，完整规格仍需要用课程工具检查语法与语义。

画布使用 `.drawio` 中记录的节点位置和连线路径点绘制 CDFD。对只有结构数据的 XML，页面会自动排列节点。可用「＋」「−」缩放并滚动画布。

## 用 draw.io 画图

- 命名过程和数据存储，并给数据流箭头添加标签。常用矩形可表示过程，虚线边框可表示外部参与者，圆柱形可表示数据存储。显示名中的空格转换为下划线，SOFL 名称须以英文字母开头。
- 图中标为虚线的数据流会生成 `sign`。存储指向过程表示读，过程指向存储或双向箭头表示可写。
- 可以在 draw.io 的「编辑数据」中给图元添加 `cdfdKind`（`process`、`store`、`actor` 或 `ignore`）。没有标注的非连接图形会被当作排版元素。若几个箭头落在同一个 SOFL 端口上，可在连线中设置相同的 `cdfdInPort` 或 `cdfdOutPort`。示例图中的 `request` 和 `request_data` 使用的是同一个输入端口。
- 进阶属性可沿用示例中的 `cdfdType`、`cdfdScope`（`local`、`external`、`existing`）、`cdfdAccess`（`rd`、`wr`）和 `cdfdSignal`（`1` 或 `0`）。图页名为 `CDFD_1` 等格式时可作为行为编号，也可以导入后在表单中修改。压缩图页使用浏览器的解压接口，旧版浏览器可改用 draw.io 导出的未压缩 XML。

## CDFD XML

```xml
<?xml version="1.0" encoding="UTF-8"?>
<cdfd module="STUDENT_LOOKUP" behavior="CDFD_1">
  <actor id="student" name="Student"/>
  <process id="query" name="Query_Student"/>
  <store id="records" name="student_file" scope="existing"/>
  <flow from="student" to="query" name="student_id" type="string"/>
  <flow from="query" to="student" name="student_info"/>
  <access process="query" store="records" mode="rd"/>
</cdfd>
```

- 三种节点共用一套互不重复的 `id`。数据流至少有一端连接过程，跨出图边界的那一端可省略。
- 相同的 `in-port` 或 `out-port` 表示同一过程、同一方向的同一个端口。未注明端口时按流名分组。
- `kind="signal"` 表示控制信号。`scope="local"` 会生成 `Init` 规格。未提供的数据类型和存储范围可以在表单中补填。
