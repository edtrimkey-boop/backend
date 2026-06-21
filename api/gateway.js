import { supabase } from '../lib/supabase.js';
import { uploadToGoogleDrive, getOrCreateFolder } from '../lib/gdrive.js';
import { sendPushNotification } from '../lib/firebase.js';

export default async function handler(req, res) {
  // 1. DYNAMIC CORS CONFIGURATION (Fixes the 127.0.0.1 block)
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin); 
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  // 2. PREFLIGHT CATCHER (Must be before anything else!)
  if (req.method === 'OPTIONS') {
      return res.status(200).end();
  }

  // 3. METHOD CHECK
  if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'Only POST allowed' });
  }

  // The rest of your try/catch logic starts here...
  const { action, email, password, token, ...payload } = req.body;
  
  // 🔥 The 'try' block begins here!
  try {
    let result = {};

    // 2. JWT SECURITY WRAPPER
    let userContext = null;
    const publicActions = ["login", "submitInstituteRegistration"];
    
    if (!publicActions.includes(action)) {
       const { data: { user }, error } = await supabase.auth.getUser(token);
       if (error || !user) {
           return res.status(200).json({ authFailed: true, message: "Session expired or invalid." });
       }
       userContext = user;
    }

    // 3. THE MASTER SWITCHBOARD
    switch (action) {
      
      // ==========================================
      // AUTHENTICATION & SECURITY
      // ==========================================
      case "login":
        const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({ email, password });
        if (authErr) throw authErr;
        
        const { data: profile } = await supabase.from('users').select('*').eq('auth_user_id', authData.user.id).single();
        if (!profile || profile.status !== 'Active') throw new Error("Account is disabled or pending.");

        result = { success: true, email: profile.email, token: authData.session.access_token, role: profile.role };
        break;

      case "changeUserPassword":
        const { error: pwErr } = await supabase.auth.admin.updateUserById(userContext.id, { password: payload.newPw });
        if (pwErr) throw pwErr;
        result = { success: true, message: "Password updated successfully!" };
        break;

      case "logoutAllDevices":
        await supabase.auth.admin.signOut(userContext.id, 'global');
        result = { success: true };
        break;

      case "updateProfilePic":
        await supabase.from('users').update({ profile_pic_url: payload.url }).eq('auth_user_id', userContext.id);
        result = { success: true };
        break;

      case "registerDeviceToken":
        const { data: currUser } = await supabase.from('users').select('device_tokens').eq('auth_user_id', userContext.id).single();
        let tokens = currUser?.device_tokens ? currUser.device_tokens.split(',') : [];
        if (!tokens.includes(payload.token)) {
            tokens.push(payload.token);
            await supabase.from('users').update({ device_tokens: tokens.join(',') }).eq('auth_user_id', userContext.id);
        }
        result = { success: true };
        break;

      // ==========================================
      // DASHBOARD DATA AGGREGATOR
      // ==========================================
     // ==========================================
      // DASHBOARD DATA AGGREGATOR
      // ==========================================
      case "getDashboardPayload":
        const { data: userData } = await supabase.from('users').select('*, institutes(*), operator_profiles(*)').eq('auth_user_id', userContext.id).single();
        if (!userData) throw new Error("User profile corrupted.");

        const isSuperAdmin = ["super admin", "system admin", "all"].includes(String(userData.role).toLowerCase());
        
        let jobsQuery = supabase.from('jobs_queue').select('*').order('created_at', { ascending: false });
        
        // 🔥 FIX: Changed from institute_code to institute_id to match your JSON!
        if (!isSuperAdmin) jobsQuery = jobsQuery.eq('institute_id', userData.institute_id);
        
        const { data: jobs } = await jobsQuery;
        
        const { data: notifications } = await supabase.from('notifications').select('*').contains('target_roles', [userData.role]).order('created_at', { ascending: false }).limit(30);

        // Safe Fallbacks
        const safeJobs = jobs || [];
        const safeNotifs = notifications || [];

// Build Payload
        result = {
          profile: {
            id: userData.id, // 🔥 FIX: This is now the 'users' table UUID!
            instId: userData.institutes?.id || '', // 🔥 FIX: This is the 'institutes' table UUID!
            email: userData.email, 
            name: userData.full_name, 
            role: userData.role, 
            institute: userData.institutes?.institute_name, 
            code: userData.institute_code,
            profilePic: userData.profile_pic_url,
            toggles: {
                attendance: userData.institutes?.attendance_toggle ? "YES" : "NO",
                admission: userData.institutes?.admission_toggle ? "YES" : "NO",
                fee: userData.institutes?.fee_toggle ? "YES" : "NO"
            },
            instDetails: userData.institutes || {},
            dynamicApps: [
              { name: "Attendance App", url: "YOUR_ATTENDANCE_URL", targetRole: "all" },
              { name: "Admission App", url: "YOUR_ADMISSION_URL", targetRole: "admin" },
              { name: "Fee System", url: "YOUR_FEE_URL", targetRole: "admin" }
            ]
          },
          data: {
          papers: safeJobs.filter(j => j.job_type === 'Paper').map(j => ({ id: j.job_code, date: j.created_at, inst: j.institute_id, class: j.meta_data?.class, subject: j.meta_data?.subject, exam: j.meta_data?.test_type, status: j.status, row: j.final_file_url })),
            docs: safeJobs.filter(j => j.job_type !== 'Paper').map(j => ({ id: j.job_code, date: j.created_at, inst: j.institute_id, class: j.meta_data.class, type: j.job_type, exam: j.meta_data.exam_name, students: j.meta_data.num_students, status: j.status, row: j.final_file_url })),
            myBilling: [],
            instTeachers: [],
            instStudents: []
          },
          notifications: safeNotifs.map(n => ({ title: n.title, msg: n.message, time: n.created_at, isRead: false })),
          stats: {
             academic: { today: safeJobs.filter(j => j.status === 'Pending').length, session: safeJobs.length, academic: safeJobs.length },
             inst: { month: safeJobs.length, academic: safeJobs.length },
             financial: { total: 0, pending: 0 }
          }
        };

        if (isSuperAdmin) {
            const { data: allInst } = await supabase.from('institutes').select('*');
            const { data: allOps } = await supabase.from('users').select('*, operator_profiles(*)').eq('role', 'operator');
            result.superAdmin = {
                kpi: { totalRev: 0, activeInst: allInst?.length || 0, pendingPay: 0, docsGen: safeJobs.length },
                institutes: (allInst || []).map(i => ({ code: i.code, name: i.institute_name, plan: i.plan_type, status: i.is_active ? 'Active' : 'Inactive', rc: 0, ac: 0, papers: 0, toggles: { attendance: i.attendance_toggle?"YES":"NO", admission: i.admission_toggle?"YES":"NO", fee: i.fee_toggle?"YES":"NO" } })),
                operatorList: (allOps || []).map(o => ({ name: o.full_name, role: o.role, status: o.status, pending: 0, assigned: 0, completed: 0, totalEarnings: 0, clearedEarnings: 0, pendingPayouts: 0, upi: o.operator_profiles[0]?.upi })),
                transactions: []
            };
        }
        break;

      // ==========================================
      // JOB CREATION (PERFECT SCHEMA MAPPING)
      // ==========================================
      case "submitPaperJob":
        // 1. SECURE FETCH: Grab the correct UUIDs based on your JSON schema
        const { data: dbUser, error: mappingErr } = await supabase
            .from('users')
            .select(`
                id, 
                institute_id, 
                institutes ( code, institute_name )
            `)
            .eq('auth_user_id', userContext.id)
            .single();
            
        if (mappingErr || !dbUser) {
            console.error("🚨 MAPPING ERROR:", mappingErr);
            throw new Error("Security Error: Account mapping invalid.");
        }

        const userUUID = dbUser.id; // Your "8d34d504..." UUID
        const instUUID = dbUser.institute_id; // Your "550e8400..." UUID
        const instCode = dbUser.institutes?.code || "INST"; // e.g., 'KPS'
        const instName = dbUser.institutes?.institute_name || "Unknown Institute";

        // 2. GENERATE CUSTOM JOB ID (e.g., TK-KPS-0001)
        const { data: latestJobs } = await supabase.from('jobs_queue')
            .select('job_code').eq('institute_id', instUUID).order('created_at', { ascending: false }).limit(1);
        
        let nextNum = 1;
        if (latestJobs && latestJobs.length > 0) {
            const lastCode = latestJobs[0].job_code;
            const parts = lastCode.split('-');
            if (parts.length > 0 && !isNaN(parts[parts.length - 1])) {
                nextNum = parseInt(parts[parts.length - 1], 10) + 1;
            }
        }
        const paperJobId = `TK-${instCode}-${String(nextNum).padStart(4, '0')}`;

        // 3. GENERATE FILE NAME (e.g., TK-KPS-0001_English_01.pdf)
        let ext = payload.mimeType === "application/pdf" ? ".pdf" : "";
        if (payload.fileName && payload.fileName.includes('.')) ext = '.' + payload.fileName.split('.').pop();
        const finalFileName = `${paperJobId}_${payload.subject}_${payload.testNo}${ext}`;

        // 4. NESTED FOLDERS: Root -> Institute Name -> Uploads_from_Teachers
        let finalFolderId = process.env.DRIVE_ROOT_FOLDER_ID || '1KFVU84_ZqiMoK5GrkAQ4s_Wzasn6Jn6t';
        if (payload.fileBase64) {
            const instFolderId = await getOrCreateFolder(instName, finalFolderId);
            finalFolderId = await getOrCreateFolder('Uploads_from_Teachers', instFolderId);
        }

        // 5. UPLOAD TO DRIVE
        let paperDriveUrl = "";
        if (payload.fileBase64) {
            paperDriveUrl = await uploadToGoogleDrive(payload.fileBase64, finalFileName, payload.mimeType, finalFolderId);
        }

        // 6. DB INSERT (Using exact UUIDs)
        const { error: dbError } = await supabase.from('jobs_queue').insert([{
            job_code: paperJobId, 
            institute_id: instUUID, // 🔥 FIX: Using the correct institute UUID
            job_type: 'Paper',
            requester_id: userUUID, // 🔥 FIX: Using the correct users table UUID
            status: 'Pending', 
            raw_file_url: paperDriveUrl,
            meta_data: { 
                class: payload.className, subject: payload.subject, test_type: payload.testType,
                test_no: payload.testNo, test_date: payload.testDate, duration: payload.duration,
                questions: payload.numQuestions, full_marks: payload.fullMarks, pass_marks: payload.passMarks,
                teacher_name: payload.teacherName
            }
        }]);

        if (dbError) throw new Error("Database Write Failed: " + dbError.message);
        result = { success: true, jobId: paperJobId };
        break;

      // ====================================================
      // JOB CREATION  DOCUMENT (CUSTOM IDS & NESTED FOLDERS)
      // ===================================================
      case "submitDocumentJob":
        let docDriveUrl = payload.fileBase64 ? await uploadToGoogleDrive(payload.fileBase64, payload.fileName, payload.mimeType) : "";
        const docJobId = `TK-D-${Math.floor(1000 + Math.random() * 9000)}`;
        
        await supabase.from('jobs_queue').insert([{
            job_code: docJobId, institute_id: payload.instCode, job_type: payload.docType,
            requester_id: userContext.id, status: 'Pending', raw_file_url: docDriveUrl,
            meta_data: { class: payload.className, exam_name: payload.examName, num_students: payload.numStudents }
        }]);
        result = { success: true, jobId: docJobId };
        break;

      // ==========================================
      // REGISTRATIONS
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
        result = { success: true, message: "Institute & Admin Account Registered." };
        break;

      case "submitTeacherRegistration":
        const { data: tchrAuth } = await supabase.auth.admin.createUser({ email: payload.email, password: "TKtchr123", email_confirm: true });
        await supabase.from('users').insert([{
            auth_user_id: tchrAuth.user.id, email: payload.email, full_name: payload.name,
            role: 'teacher', institute_code: payload.instCode, status: 'Active', profile_pic_url: payload.photoUrl
        }]);
        result = { success: true };
        break;

      case "submitOperatorRegistration":
        const { data: opAuth } = await supabase.auth.admin.createUser({ email: payload.email, password: "TKoperator123", email_confirm: true });
        const { data: newOp } = await supabase.from('users').insert([{
            auth_user_id: opAuth.user.id, email: payload.email, full_name: payload.name,
            role: 'operator', status: 'Active', profile_pic_url: payload.photoUrl
        }]).select().single();
        
        await supabase.from('operator_profiles').insert([{
            user_id: newOp.id, subjects: payload.subjects, work_type: payload.workType, 
            rate_paper: payload.ratePaper, rate_unit: payload.rateUnit, upi: payload.upi
        }]);
        result = { success: true };
        break;

      // ==========================================
      // OPERATOR & ADMIN TOGGLES
      // ==========================================
      case "updateOperatorDetails":
        const { data: opUser } = await supabase.from('users').select('id').eq('full_name', payload.originalName).single();
        if(opUser) {
           await supabase.from('users').update({ status: payload.status }).eq('id', opUser.id);
           await supabase.from('operator_profiles').update({ subjects: payload.subjects, work_type: payload.workType, rate_paper: payload.ratePaper, rate_unit: payload.rateUnit }).eq('user_id', opUser.id);
        }
        result = { success: true };
        break;

      case "assignJobToOperator":
        const { data: opToAssign } = await supabase.from('users').select('id, device_tokens').eq('full_name', payload.operatorName).single();
        if(opToAssign) {
            await supabase.from('jobs_queue').update({ operator_id: opToAssign.id, status: 'Assigned' }).eq('job_code', payload.jobId);
            if (opToAssign.device_tokens) {
               await sendPushNotification(opToAssign.device_tokens.split(','), "New Job Assigned", `Job ${payload.jobId} assigned to you.`);
            }
        }
        result = { success: true, message: `Job officially assigned.` };
        break;

      case "processOperatorPayout":
        result = { success: true, message: "Payout marked as settled." };
        break;

      case "toggleInstituteApp":
        const tUpdate = {};
        if(payload.appType === 'attendance') tUpdate.attendance_toggle = (payload.stateStr === 'YES');
        if(payload.appType === 'admission') tUpdate.admission_toggle = (payload.stateStr === 'YES');
        if(payload.appType === 'fee') tUpdate.fee_toggle = (payload.stateStr === 'YES');
        await supabase.from('institutes').update(tUpdate).eq('code', payload.instCode);
        result = { success: true };
        break;

      case "deleteOperatorAccess":
      case "deleteTeacherAccess":
        await supabase.from('users').delete().eq(payload.name ? 'full_name' : 'email', payload.name || payload.email);
        result = { success: true };
        break;

      case "removeOperatorAccess":
      case "removeTeacherAccess":
        await supabase.from('users').update({ status: 'Inactive' }).eq(payload.name ? 'full_name' : 'email', payload.name || payload.email);
        result = { success: true };
        break;

      case "restoreOperatorAccess":
      case "restoreTeacherAccess":
        await supabase.from('users').update({ status: 'Active' }).eq(payload.name ? 'full_name' : 'email', payload.name || payload.email);
        result = { success: true };
        break;

      // ==========================================
      // UTILS
      // ==========================================
      case "createPaymentLink":
        result = { success: true, refId: `TXN-${Date.now()}`, amount: payload.amount };
        break;

      case "sendNotification":
        await supabase.from('notifications').insert([{
            sender_id: userContext.id, target_roles: [payload.targetRaw], title: payload.title, message: payload.msg
        }]);
        result = { success: true, message: "Broadcast sent." };
        break;

      case "markNotificationsRead":
        result = { success: true };
        break;

      case "getGeneratedFolderUrl":
        result = { success: true, url: "https://drive.google.com/drive/folders/" + process.env.DRIVE_ROOT_FOLDER_ID };
        break;

      case "download":
        result = { success: true, url: payload.row };
        break;

      default:
        throw new Error("Invalid API Action requested: " + action);
    }

    return res.status(200).json(result);

  // 🔥 The 'catch' block belongs to the 'try' block above!
  } catch (error) {
    console.error(error);
    return res.status(200).json({ success: false, message: error.message });
  }
}
