import { supabase } from '../lib/supabase.js';
import { uploadToGoogleDrive } from '../lib/gdrive.js';
import { sendPushNotification } from '../lib/firebase.js';

export default async function handler(req, res) {
  // CORS Configuration for Hostinger
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Only POST allowed' });

  const { action, payload, email, password, token } = req.body;
  
  try {
    let result = {};

    // JWT Security Wrapper (skips login/registration)
    let userContext = null;
    if (!["login", "submitInstituteRegistration"].includes(action)) {
       const { data: { user }, error } = await supabase.auth.getUser(token);
       if (error || !user) return res.status(401).json({ authFailed: true, message: "Session expired or invalid." });
       userContext = user;
    }

    // THE MASTER SWITCHBOARD
    switch (action) {
      
      // ==========================================
      // AUTHENTICATION & SECURITY
      // ==========================================
      case "login":
        const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({ email, password });
        if (authErr) throw authErr;
        
        const { data: profile } = await supabase.from('users').select('*').eq('auth_user_id', authData.user.id).single();
        if (profile.status !== 'Active') throw new Error("Account is disabled or pending.");

        result = { success: true, email: profile.email, token: authData.session.access_token, role: profile.role };
        break;

      case "changePassword":
        const { error: pwErr } = await supabase.auth.admin.updateUserById(userContext.id, { password: payload.newPassword });
        if (pwErr) throw pwErr;
        result = { success: true, message: "Password updated successfully!" };
        break;

      case "registerDeviceToken":
        const { data: currUser } = await supabase.from('users').select('device_tokens').eq('email', email).single();
        let tokens = currUser.device_tokens ? currUser.device_tokens.split(',') : [];
        if (!tokens.includes(payload.token)) {
            tokens.push(payload.token);
            await supabase.from('users').update({ device_tokens: tokens.join(',') }).eq('email', email);
        }
        result = { success: true };
        break;

      // ==========================================
      // CORE DASHBOARD & JOBS
      // ==========================================
      case "getDashboardPayload":
        const { data: userData } = await supabase.from('users').select('*, institutes(*), operator_profiles(*)').eq('auth_user_id', userContext.id).single();
        const { data: jobs } = await supabase.from('jobs_queue').select('*').eq('institute_id', userData.institute_code).order('created_at', { ascending: false });
        const { data: notifications } = await supabase.from('notifications').select('*').contains('target_roles', [userData.role]).order('created_at', { ascending: false }).limit(30);

        result = {
          profile: {
            email: userData.email, name: userData.full_name, role: userData.role, 
            institute: userData.institutes?.institute_name, code: userData.institute_code,
            profilePic: userData.profile_pic_url,
            toggles: {
                attendance: userData.institutes?.attendance_toggle ? "YES" : "NO",
                admission: userData.institutes?.admission_toggle ? "YES" : "NO",
                fee: userData.institutes?.fee_toggle ? "YES" : "NO"
            },
            instDetails: { logoUrl: userData.institutes?.logo_url }
          },
          data: {
            papers: jobs.filter(j => j.job_type === 'Paper').map(j => ({ id: j.job_code, date: j.created_at, inst: userData.institutes?.institute_name, class: j.meta_data.class, subject: j.meta_data.subject, exam: j.meta_data.test_type, status: j.status, row: j.final_file_url })),
            docs: jobs.filter(j => j.job_type !== 'Paper').map(j => ({ id: j.job_code, date: j.created_at, inst: userData.institutes?.institute_name, class: j.meta_data.class, type: j.job_type, exam: j.meta_data.exam_name, students: j.meta_data.num_students, status: j.status, row: j.final_file_url }))
          },
          notifications: notifications,
          stats: {}, pricingMaster: []
        };
        break;

      case "submitPaperJob":
        let paperDriveUrl = payload.fileBase64 ? await uploadToGoogleDrive(payload.fileBase64, payload.fileName, payload.mimeType) : "";
        const paperJobId = `TK-P-${Math.floor(1000 + Math.random() * 9000)}`;
        
        await supabase.from('jobs_queue').insert([{
            job_code: paperJobId, institute_id: payload.instCode, job_type: 'Paper',
            requester_id: payload.userId, status: 'Pending', raw_file_url: paperDriveUrl,
            meta_data: { class: payload.className, subject: payload.subject, test_type: payload.testType }
        }]);
        result = { success: true, message: "Paper Processed.", jobId: paperJobId };
        break;

      case "submitDocumentJob":
        let docDriveUrl = payload.fileBase64 ? await uploadToGoogleDrive(payload.fileBase64, payload.fileName, payload.mimeType) : "";
        const docJobId = `TK-D-${Math.floor(1000 + Math.random() * 9000)}`;
        
        await supabase.from('jobs_queue').insert([{
            job_code: docJobId, institute_id: payload.instCode, job_type: payload.docType,
            requester_id: payload.userId, status: 'Pending', raw_file_url: docDriveUrl,
            meta_data: { class: payload.className, exam_name: payload.examName, num_students: payload.numStudents }
        }]);
        result = { success: true, message: "Document Processed.", jobId: docJobId };
        break;

      // ==========================================
      // WORKFORCE & ASSIGNMENT (OPERATORS)
      // ==========================================
      case "assignJobToOperator":
        const { error: assignErr } = await supabase.from('jobs_queue').update({ operator_id: payload.operatorId, status: 'Assigned' }).eq('job_code', payload.jobId);
        if (assignErr) throw assignErr;

        // Send Push to Operator
        const { data: opData } = await supabase.from('users').select('device_tokens').eq('id', payload.operatorId).single();
        if (opData?.device_tokens) {
           await sendPushNotification(opData.device_tokens.split(','), "New Job Assigned", `Job ${payload.jobId} has been assigned to you.`);
        }
        result = { success: true, message: `Job officially assigned.` };
        break;

      case "processOperatorPayout":
        const { data: unpaidJobs } = await supabase.from('billing_ledger').select('id, amount').eq('operator_id', payload.operatorId).eq('status', 'Pending');
        let totalSettled = 0;
        
        for (const job of unpaidJobs) {
            await supabase.from('billing_ledger').update({ status: 'Paid' }).eq('id', job.id);
            totalSettled += Number(job.amount);
        }
        result = { success: true, message: `Successfully settled ₹${totalSettled} across ${unpaidJobs.length} jobs.` };
        break;

      case "updateOperatorDetails":
        await supabase.from('operator_profiles').update({
            subjects: payload.subjects, work_type: payload.workType, 
            rate_paper: payload.ratePaper, rate_unit: payload.rateUnit
        }).eq('user_id', payload.userId);
        
        await supabase.from('users').update({ status: payload.status }).eq('id', payload.userId);
        result = { success: true, message: "Operator Settings Updated." };
        break;

      // ==========================================
      // REGISTRATIONS & ACCESS CONTROL
      // ==========================================
      case "submitInstituteRegistration":
        await supabase.from('institutes').insert([{
            code: payload.instCode, institute_name: payload.instName, plan_type: payload.planType,
            logo_url: payload.logoUrl, is_active: true, attendance_toggle: payload.attendanceToggle === "YES",
            admission_toggle: payload.admissionToggle === "YES", fee_toggle: payload.feeToggle === "YES"
        }]);

        const { data: instAuth } = await supabase.auth.admin.createUser({ email: payload.adminEmail, password: "TKadmin123", email_confirm: true });
        await supabase.from('users').insert([{
            auth_user_id: instAuth.user.id, email: payload.adminEmail, full_name: payload.clientName || "Admin",
            role: 'admin', institute_code: payload.instCode, status: 'Active'
        }]);
        result = { success: true, message: "Institute & Admin Account Registered Successfully." };
        break;

      case "submitTeacherRegistration":
        const { data: tchrAuth } = await supabase.auth.admin.createUser({ email: payload.email, password: "TKtchr123", email_confirm: true });
        await supabase.from('users').insert([{
            auth_user_id: tchrAuth.user.id, email: payload.email, full_name: payload.name,
            role: 'teacher', institute_code: payload.instCode, status: 'Active', profile_pic_url: payload.photoUrl
        }]);
        result = { success: true, message: "Teacher added successfully!" };
        break;

      case "toggleInstituteApp":
        const toggleUpdate = {};
        if(payload.appType === 'attendance') toggleUpdate.attendance_toggle = (payload.stateStr === 'YES');
        if(payload.appType === 'admission') toggleUpdate.admission_toggle = (payload.stateStr === 'YES');
        if(payload.appType === 'fee') toggleUpdate.fee_toggle = (payload.stateStr === 'YES');
        
        await supabase.from('institutes').update(toggleUpdate).eq('code', payload.instCode);
        result = { success: true, message: "Web App updated successfully." };
        break;

      // Status Toggles (Delete / Restore)
      case "removeTeacherAccess":
      case "deleteOperatorAccess":
         await supabase.from('users').update({ status: 'Inactive' }).eq('email', payload.email);
         result = { success: true, message: "User access revoked." };
         break;

      case "restoreTeacherAccess":
      case "restoreOperatorAccess":
         await supabase.from('users').update({ status: 'Active' }).eq('email', payload.email);
         result = { success: true, message: "User access restored." };
         break;

      // ==========================================
      // NOTIFICATIONS ENGINE
      // ==========================================
      case "sendNotification":
        // 1. Save to Database
        await supabase.from('notifications').insert([{
            sender_id: userContext.id, target_roles: [payload.targetRole], 
            target_institute: payload.targetInst, title: payload.title, message: payload.msg
        }]);

        // 2. Fetch tokens matching criteria
        let tokenQuery = supabase.from('users').select('device_tokens').neq('device_tokens', null);
        if (payload.targetRole !== 'all') tokenQuery = tokenQuery.eq('role', payload.targetRole);
        if (payload.targetInst !== 'all') tokenQuery = tokenQuery.eq('institute_code', payload.targetInst);
        
        const { data: targetUsers } = await tokenQuery;
        let allTokens = [];
        targetUsers.forEach(u => allTokens.push(...u.device_tokens.split(',')));

        // 3. Send Push via Firebase
        if (allTokens.length > 0) {
            await sendPushNotification(allTokens, payload.title, payload.msg);
        }
        result = { success: true, message: "Broadcast sent successfully." };
        break;

      case "markNotificationsRead":
        // Logic to update user's read_notifications array in DB
        result = { success: true };
        break;

      default:
        throw new Error("Invalid API Action requested: " + action);
    }

    // Return the response perfectly formatted for Hostinger HTML
    return res.status(200).json(result);

  } catch (error) {
    console.error(error);
    return res.status(200).json({ success: false, message: error.message });
  }
}
