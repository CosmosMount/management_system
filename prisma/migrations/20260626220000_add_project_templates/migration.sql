-- CreateTable
CREATE TABLE "ProjectTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectTemplateStage" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT NOT NULL DEFAULT '',
    "dueOffsetDays" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectTemplateStage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectTemplate_name_key" ON "ProjectTemplate"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectTemplate_single_default_idx" ON "ProjectTemplate"("isDefault") WHERE "isDefault" = true;

-- CreateIndex
CREATE INDEX "ProjectTemplateStage_templateId_sortOrder_idx" ON "ProjectTemplateStage"("templateId", "sortOrder");

-- AddForeignKey
ALTER TABLE "ProjectTemplateStage" ADD CONSTRAINT "ProjectTemplateStage_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ProjectTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed default template
INSERT INTO "ProjectTemplate" (
    "id",
    "name",
    "description",
    "isDefault",
    "enabled",
    "sortOrder",
    "createdAt",
    "updatedAt"
) VALUES (
    'project-template-real-car',
    '实车模板',
    '默认实车项目阶段模板',
    true,
    true,
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
) ON CONFLICT ("name") DO NOTHING;

INSERT INTO "ProjectTemplateStage" (
    "id",
    "templateId",
    "name",
    "goal",
    "dueOffsetDays",
    "sortOrder",
    "createdAt",
    "updatedAt"
) VALUES
    ('project-template-real-car-stage-1', 'project-template-real-car', '研讨', '明确目标、约束、方案和验收口径', 7, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('project-template-real-car-stage-2', 'project-template-real-car', '机电连线图', '完成机电接口、走线与连接关系文档', 14, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('project-template-real-car-stage-3', 'project-template-real-car', '机械图纸绘制', '完成机械结构图纸与加工前评审材料', 21, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('project-template-real-car-stage-4', 'project-template-real-car', '发加工', '完成加工文件归档并确认加工状态', 28, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('project-template-real-car-stage-5', 'project-template-real-car', '装车布线', '完成实车装配、布线和基础检查', 35, 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('project-template-real-car-stage-6', 'project-template-real-car', '第一次上电验收', '完成首次上电检查与问题记录', 42, 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('project-template-real-car-stage-7', 'project-template-real-car', '基础功能验收', '完成底盘、通信、控制等基础功能确认', 49, 6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('project-template-real-car-stage-8', 'project-template-real-car', '功能实现', '完成项目目标功能并沉淀关键数据', 56, 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('project-template-real-car-stage-9', 'project-template-real-car', '留档', '完成文档、视频、数据和复盘材料归档', 63, 8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
