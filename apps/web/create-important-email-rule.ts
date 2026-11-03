import { PrismaClient } from "./generated/prisma/client";

process.env.DATABASE_URL =
  "postgresql://postgres:26b8c1a016434919d358f7f09102c418@127.0.0.1:5432/inboxzero?schema=public";

const prisma = new PrismaClient();

async function createImportantEmailRule() {
  try {
    // Get all email accounts
    const emailAccounts = await prisma.emailAccount.findMany({
      select: {
        id: true,
        email: true,
      },
    });

    console.log("Found email accounts:", emailAccounts);

    // Create rule for each email account
    for (const account of emailAccounts) {
      // Check if rule already exists
      const existingRule = await prisma.rule.findFirst({
        where: {
          emailAccountId: account.id,
          name: "重要邮件识别",
        },
      });

      if (existingRule) {
        console.log(`Rule already exists for ${account.email}, skipping`);
        continue;
      }

      // Create rule with AI instructions
      const rule = await prisma.rule.create({
        data: {
          name: "重要邮件识别",
          emailAccountId: account.id,
          enabled: true,
          instructions:
            "Identify emails that are important and require the user's attention. This includes:\n- Urgent requests or deadlines\n- High-priority work communications\n- Important updates or announcements\n- Emails from key stakeholders\n- Any communication that requires a timely response\n\nIf the email is important, mark it as such. If it's routine, low-priority, or spam, do not mark it.",
          actions: {
            create: [
              {
                type: "CALL_WEBHOOK",
                url: "https://mail.zxytech.cn/webhook-relay/webhook",
                emailAccountId: account.id,
              },
            ],
          },
        },
      });

      console.log(`Created rule for ${account.email}: ${rule.id}`);
    }

    console.log("Done!");
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await prisma.$disconnect();
  }
}

createImportantEmailRule();
