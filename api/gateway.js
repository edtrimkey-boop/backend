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
      case "getDashboardPayload":
        const { data: userData, error: userErr } = await supabase
            .from('users')
            .select('*, institutes(*), operator_profiles(*)')
            .eq('auth_user_id', userContext.id)
            .single();
            
        if (userErr || !userData) throw new Error("User profile corrupted.");

        const { data: teacherProfile } = await supabase
            .from('teacher_profiles')
            .select('subject_handles')
            .eq('user_id', userData.id)
            .maybeSingle(); 

        let formattedTeacherSubjects = null;
        if (teacherProfile && teacherProfile.subject_handles) {
            const handles = teacherProfile.subject_handles;
            formattedTeacherSubjects = Array.isArray(handles) ? handles.join(', ') : handles;
        }
        
        // 1. DETERMINE STRICT PRIVACY FILTERS (🔥 FIXED SCOPE VARIABLES)
        const dashRole = String(userData.role).trim().toLowerCase();
        const dashUserUUID = userData.id;
        const dashInstUUID = userData.institute_id;

        let papersQuery = supabase.from('jobs_queue').select('*').eq('job_type', 'Paper');
        let docsQuery = supabase.from('jobs_queue').select('*').not('job_type', 'eq', 'Paper');

        if (dashRole === 'teacher') {
            papersQuery = papersQuery.eq('requester_id', dashUserUUID);
            docsQuery = docsQuery.eq('requester_id', dashUserUUID);
        } else if (dashRole === 'admin') {
            papersQuery = papersQuery.eq('institute_id', dashInstUUID);
            docsQuery = docsQuery.eq('institute_id', dashInstUUID);
        } else if (dashRole === 'operator') {
            papersQuery = papersQuery.eq('operator_id', dashUserUUID);
            docsQuery = docsQuery.eq('operator_id', dashUserUUID);
        }

        // 2. EXECUTE ISOLATED FETCHES
        const { data: papersData } = await papersQuery.order('created_at', { ascending: false });
        const { data: docsData } = await docsQuery.order('created_at', { ascending: false });

        // Safely merge the secure data streams back into one array!
        const safeJobs = [...(papersData || []), ...(docsData || [])];

        // 3. FETCH NOTIFICATIONS
        const { data: notifications } = await supabase.from('notifications')
            .select('*')
            .contains('target_roles', [userData.role])
            .order('created_at', { ascending: false })
            .limit(30);
        const safeNotifs = notifications || [];

        // Build Payload
        result = {
          profile: {
            id: userData.id,
            instId: userData.institute_id || '',
            email: userData.email, 
            name: userData.full_name, 
            role: userData.role, 
            subjects: formattedTeacherSubjects || userData.subjects || userData.operator_profiles?.[0]?.subjects || 'Not Assigned',
            institute: userData.institutes?.institute_name, 
            code: userData.institutes?.institute_code || userData.institutes?.code || '',
            logo: userData.institutes?.logo_url || userData.institutes?.logo || userData.institutes?.institute_logo || '', 
            profilePic: userData.profile_pic_url,
            toggles: {
                attendance: userData.institutes?.attendance_toggle ? "YES" : "NO",
                admission: userData.institutes?.admission_toggle ? "YES" : "NO",
                fee: userData.institutes?.fee_toggle ? "YES" : "NO"
            },
            instDetails: userData.institutes || {}
          },
          data: {
            papers: safeJobs.filter(j => j.job_type === 'Paper').map(j => ({ 
                id: j.job_code, 
                date: j.created_at, 
                inst: userData.institutes?.institute_name || 'Unknown', 
                class: j.meta_data?.class || '', 
                subject: j.meta_data?.subject || '', 
                exam: j.meta_data?.test_type || '', 
                deadline: j.deadline || 'No Deadline', 
                status: j.status, 
                row: j.final_file_url || j.raw_file_url || '' 
            })),
            docs: safeJobs.filter(j => j.job_type !== 'Paper').map(j => ({ 
                id: j.job_code, 
                date: j.created_at, 
                inst: userData.institutes?.institute_name || 'Unknown', 
                class: j.meta_data?.class || '', 
                type: j.job_type, 
                exam: j.meta_data?.exam_name || '', 
                students: j.meta_data?.num_students || 0, 
                deadline: j.deadline || 'No Deadline',
                status: j.status, 
                row: j.final_file_url || j.raw_file_url || '' 
            })),
            myBilling: [], instTeachers: [], instStudents: []
          },
          notifications: safeNotifs.map(n => ({ title: n.title, msg: n.message, time: n.created_at, isRead: false })),
          stats: {
             academic: { today: safeJobs.filter(j => j.status === 'Pending').length, session: safeJobs.length, academic: safeJobs.length },
             inst: { month: safeJobs.length, academic: safeJobs.length },
             financial: { total: 0, pending: 0 }
          }
        };

        const isSuperAdmin = ["super admin", "system admin", "all"].includes(dashRole);
        if (isSuperAdmin) {
            const { data: allInst } = await supabase.from('institutes').select('*');
            const { data: allOps } = await supabase.from('users').select('*, operator_profiles(*)').eq('role', 'operator');
            result.superAdmin = {
                kpi: { totalRev: 0, activeInst: allInst?.length || 0, pendingPay: 0, docsGen: safeJobs.length },
                institutes: (allInst || []).map(i => ({ code: i.institute_code || i.code || '', name: i.institute_name, plan: i.plan_type, status: i.is_active ? 'Active' : 'Inactive', rc: 0, ac: 0, papers: 0, toggles: { attendance: i.attendance_toggle?"YES":"NO", admission: i.admission_toggle?"YES":"NO", fee: i.fee_toggle?"YES":"NO" } })),
                operatorList: (allOps || []).map(o => ({ name: o.full_name, role: o.role, status: o.status, pending: 0, assigned: 0, completed: 0, totalEarnings: 0, clearedEarnings: 0, pendingPayouts: 0, upi: o.operator_profiles[0]?.upi })),
                transactions: []
            };
        }
        break;

      // ==========================================
      // JOB CREATION (ISOLATED INST COUNTER & DYNAMIC DRIVE ROUTING)
      // ==========================================
      case "submitPaperJob":
        // 1. SECURE USER FETCH: Get structural records via auth reference
        const { data: dbUser, error: submitUserErr } = await supabase
            .from('users')
            .select('id, institute_id')
            .eq('auth_user_id', userContext.id)
            .single();
            
        if (submitUserErr || !dbUser) {
            console.error("🚨 USER FETCH ERROR:", submitUserErr);
            throw new Error("Security Error: Account mapping invalid.");
        }

        const userUUID = dbUser.id;
        const instUUID = dbUser.institute_id;

        // 2. SAFE INSTITUTE FETCH: Use select('*') to entirely bypass PostgreSQL column crashes
        const { data: dbInst, error: submitInstErr } = await supabase
            .from('institutes')
            .select('*')
            .eq('id', instUUID)
            .single();

        if (submitInstErr || !dbInst) {
            console.error("🚨 INSTITUTE FETCH ERROR:", submitInstErr);
            throw new Error("Security Error: Institute mapping invalid.");
        }

        const instCode = dbInst.institute_code || dbInst.code || "INST";
        const instName = dbInst.institute_name || "Unknown Institute";

   // 3. UNIVERSAL JOB ID ENGINE (WITH INDEPENDENT SEQUENCES)
        const jobTypeStr = payload.jobType || "Paper"; // Ensures papers get categorized safely
        const jobTypeCodes = {
            "Paper": "PPR",
            "Report Card": "RC",
            "Admit Card": "AC",
            "ID Card": "ID",
            "Certificate": "CERT"
        };
        const typeCode = jobTypeCodes[jobTypeStr] || "GEN";
        const currentYearStr = new Date().getFullYear().toString().slice(-2);

        // 🔥 FIX: Added .eq('job_type') so Papers and Documents have separate 0001 sequences!
        const { data: latestJobs } = await supabase
            .from('jobs_queue')
            .select('job_code')
            .eq('institute_id', instUUID)
            .eq('job_type', jobTypeStr) 
            .order('created_at', { ascending: false })
            .limit(1);
        
        let nextNum = 1;
        if (latestJobs && latestJobs.length > 0) {
            const lastCode = latestJobs[0].job_code;
            const match = lastCode.match(/\d+$/);
            if (match) nextNum = parseInt(match[0], 10) + 1;
        }
        
        const universalJobId = `${instCode}-${typeCode}-${currentYearStr}-${String(nextNum).padStart(4, '0')}`;

// 4. PRECISE FILE NAMING SCHEME (Job ID ONLY)
        let ext = payload.mimeType === "application/pdf" ? ".pdf" : "";
        if (payload.fileName && payload.fileName.includes('.')) ext = '.' + payload.fileName.split('.').pop();
        
        // 🔥 FIX 1: The file name is now strictly the universal ID
        const finalFileName = `${universalJobId}${ext}`;

        // 5. DEEP NESTED DRIVE ROUTING (Fixed Duplicate Root)
        // Base Folder IS '4_Institutes'
        let baseFolderId = process.env.DRIVE_ROOT_FOLDER_ID || '1U0hXB394ogLsfRCpjbtR-XU48B_Xutzt';
        let finalFolderId = baseFolderId;

        if (payload.fileBase64) {
            const examName = payload.testType || payload.examName || "Exam"; 
            const sessionStr = payload.session || "2026-2027";
            
            // 🔥 FIX 2: We search for the Institute directly inside the Base Folder
            const level2_InstName = await getOrCreateFolder(instName, baseFolderId);

            if (jobTypeStr === "Paper") {
                // Paper Route: 4_Institutes -> Keystone Public School -> Uploads_from_Teachers
                finalFolderId = await getOrCreateFolder('Uploads_from_Teachers', level2_InstName);
            } else {
                // Document Route: 4_Institutes -> Keystone Public School -> Documents_Upload -> Report Cards -> 2026-2027 -> Class 1 -> Annual Term Exam
                const level3_Docs = await getOrCreateFolder('Documents_Upload', level2_InstName);
                const level4_Type = await getOrCreateFolder(jobTypeStr, level3_Docs);
                const level5_Session = await getOrCreateFolder(sessionStr, level4_Type);
                const level6_Class = await getOrCreateFolder(payload.className || 'Unknown Class', level5_Session);
                finalFolderId = await getOrCreateFolder(examName, level6_Class);
            }
        }

        // 6. EXECUTE SECURE DRIVE BROADCAST
        let paperDriveUrl = "";
        if (payload.fileBase64) {
            paperDriveUrl = await uploadToGoogleDrive(payload.fileBase64, finalFileName, payload.mimeType, finalFolderId);
        }

        // 🔥 FIX 1: Generate a perfect 48-hour deadline directly on the server
        const deadlineDate = new Date();
        deadlineDate.setHours(deadlineDate.getHours() + 48);
        const autoDeadlineTimestamp = deadlineDate.toISOString(); 

  // 6.5 BULLETPROOF AUTO-ASSIGN OPERATOR ENGINE
        let assignedOperatorId = null;
        
        // Fetch all operators
        const { data: operators, error: opErr } = await supabase
            .from('operator_profiles')
            .select('*');

        console.log(`[Auto-Assign] Found ${operators ? operators.length : 0} operators in DB.`);

        if (!opErr && operators && operators.length > 0) {
            const matchingOperators = operators.filter(op => {
                const safeWorkTypes = JSON.stringify(op.work_types || op.workType || "").toLowerCase();
                const safeSubjects = JSON.stringify(op.subjects || "").toLowerCase();
                
                const searchWork = (jobTypeStr || "paper").toLowerCase();
                const handlesWork = safeWorkTypes.includes(searchWork) || safeWorkTypes.includes("paper format"); 
                
                let handlesSubject = true;
                if (payload.subject) {
                    const searchSub = payload.subject.toLowerCase();
                    handlesSubject = safeSubjects.includes(searchSub) || 
                                     (searchSub === 'mathematics' && safeSubjects.includes('math'));
                }

                // 🔥 THE FIX: If status is null or undefined, assume they are active!
                const isActive = (!op.status || op.status === "Active" || op.status === "Connected");

                // Logs the exact math to your Vercel Dashboard so you can see it!
                console.log(`[Auto-Assign Check] Op ID: ${op.user_id} | WorkMatch: ${handlesWork} | SubMatch: ${handlesSubject} | Active: ${isActive}`);

                return handlesWork && handlesSubject && isActive;
            });

            console.log(`[Auto-Assign] Found ${matchingOperators.length} perfect matches!`);

            if (matchingOperators.length > 0) {
                const randomIndex = Math.floor(Math.random() * matchingOperators.length);
                // 🔥 Fallback: Grab user_id. If missing, grab id.
                assignedOperatorId = matchingOperators[randomIndex].user_id || matchingOperators[randomIndex].id;
                console.log(`[Auto-Assign] SUCCESS! Assigned to Operator: ${assignedOperatorId}`);
            }
        } else {
            console.log(`[Auto-Assign] Error or empty table:`, opErr);
        }

        // 7. RECORD PERSISTENCE
        const { error: submitDbError } = await supabase.from('jobs_queue').insert([{
            job_code: universalJobId, 
            institute_id: instUUID, 
            job_type: jobTypeStr, 
            requester_id: userUUID, 
            operator_id: assignedOperatorId, // 🔥 FIX: Saves the auto-assigned Operator's ID!
            status: 'Pending', // Keeps it pending until the operator starts it
            raw_file_url: paperDriveUrl,
            deadline: autoDeadlineTimestamp,
            meta_data: { 
                class: payload.className, 
                exam_name: payload.examName, 
                subject: payload.subject, 
                test_type: payload.testType,
                test_no: payload.testNo, 
                test_date: payload.testDate || payload.docDate, 
                num_students: payload.numStudents,
                duration: payload.duration,
                questions: payload.numQuestions, 
                full_marks: payload.fullMarks, 
                pass_marks: payload.passMarks,
                teacher_name: payload.teacherName
            }
        }]);

        if (submitDbError) throw new Error("Database Write Failed: " + submitDbError.message);
        
        result = { success: true, jobId: universalJobId }; // 🔥 CHANGE 2: Used to be paperJobId
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
